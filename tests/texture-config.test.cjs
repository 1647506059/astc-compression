const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planRecords, formatsFor, platformSummary, normalizeUrl } = require('../lib/texture-config');
const { createService } = require('../lib/asset-service');

const defaults = { block: '6x6', quality: 'medium', fallbackQuality: 80, sourceType: 'all' };
const clone = value => JSON.parse(JSON.stringify(value));
function asset(url, meta = {}) {
    return { url: 'db://assets/' + url, uuid: url, inScope: true,
        meta: { importer: /\.pac$/i.test(url) ? 'auto-atlas' : 'texture', type: 'sprite', width: 100, height: 100,
            maxWidth: 1024, maxHeight: 1024, platformSettings: {}, ...meta } };
}

function mockDb(input, options = {}) {
    const assets = clone(input), writes = [], calls = [];
    const requests = { meta: 0, url: 0 };
    let active = 0, maximum = 0;
    const db = {
        queryAssets(pattern, type, callback) {
            calls.push({ pattern, type });
            let matches;
            if (pattern.endsWith('/**/*')) matches = assets.filter(item => item.url.startsWith(pattern.slice(0, -4)));
            else if (pattern.endsWith('/*.pac')) matches = assets.filter(item => item.url.slice(0, item.url.lastIndexOf('/')) === pattern.slice(0, -6) && item.meta.importer === 'auto-atlas');
            else matches = assets.filter(item => item.url === pattern);
            matches = matches.filter(item => type === 'auto-atlas' ? item.meta.importer === type : item.meta.importer === 'texture');
            if (options.emptyQuery) matches = [];
            callback(null, matches.map(item => ({ uuid: item.uuid, url: item.url })));
        },
        queryMetaInfoByUuid(uuid, callback) {
            requests.meta++;
            if (options.readFailure === uuid) { callback(new Error('meta read failed')); return; }
            const item = assets.find(item => item.uuid === uuid);
            callback(null, item && { json: JSON.stringify({ uuid: item.uuid, ...item.meta }) });
        },
        queryUrlByUuid(uuid, callback) { requests.url++; callback(null, options.moved === uuid ? 'db://assets/moved.png' : (assets.find(item => item.uuid === uuid) || {}).url); },
        remote: { urlToUuid(url) { return (assets.find(item => item.url === url) || {}).uuid; } },
        saveMeta(uuid, json, callback) {
            active++; maximum = Math.max(maximum, active);
            setTimeout(() => {
                active--;
                if (options.writeFailure === uuid) { callback(new Error('save failed')); return; }
                writes.push({ uuid, json });
                assets.find(item => item.uuid === uuid).meta = JSON.parse(json);
                callback(null);
            }, 2);
        },
    };
    return { db, assets, writes, calls, requests, maximum: () => maximum };
}

test('有图集配置图集，无图集时 PNG/JPG/JPEG 都配置碎图', () => {
    const rows = planRecords([asset('ui/ui.pac'), asset('ui/a.png'), asset('ui/b.JPG'), asset('background/c.jpeg'), asset('other/d.PNG')]);
    assert.deepEqual(rows.filter(row => row.eligible).map(row => row.kind).sort(), ['atlas', 'jpg', 'png']);
    assert.equal(rows.filter(row => row.ownerUuid).length, 2);
});

test('目录匹配有边界，ui 的图集不影响 ui2；嵌套图集使用最近父目录', () => {
    const rows = planRecords([asset('ui/ui.pac'), asset('ui/nested/nested.pac'), asset('ui2/a.png'), asset('ui/nested/b.png')]);
    assert.equal(rows.find(row => row.url.endsWith('ui2/a.png')).eligible, true);
    assert.equal(rows.find(row => row.url.endsWith('nested/b.png')).ownerUuid, 'ui/nested/nested.pac');
});

test('超大图与非 Sprite 纹理不因目录有图集而漏配', () => {
    const rows = planRecords([asset('ui/ui.pac'), asset('ui/large.jpg', { height: 2000 }), asset('ui/raw.png', { type: 'raw' })]);
    assert.equal(rows.filter(row => row.kind !== 'atlas' && row.eligible).length, 2);
});

test('同目录多个图集暂停自动配置并呈现冲突', () => {
    const rows = planRecords([asset('ui/a.pac'), asset('ui/b.pac'), asset('ui/a.png')]);
    assert.ok(rows.every(row => !row.eligible && row.conflict));
});

test('PNG/图集保留透明回退，JPG 使用 JPG 回退；拒绝非法压缩参数', () => {
    for (const kind of ['png', 'atlas']) assert.equal(formatsFor({ kind }, defaults)[1].name, 'png');
    assert.equal(formatsFor({ kind: 'jpg' }, defaults)[1].name, 'jpg');
    assert.equal(formatsFor({ kind: 'jpg' }, defaults)[0].name, 'astc_6x6');
    assert.throws(() => formatsFor({ kind: 'png' }, { ...defaults, block: '99x99' }), /无效/);
    assert.throws(() => formatsFor({ kind: 'png' }, { ...defaults, fallbackQuality: 101 }), /0–100/);
    assert.throws(() => formatsFor({ kind: 'png' }, { ...defaults, fallbackQuality: '' }), /0–100/);
});

test('区分平台本身配置和继承默认配置', () => {
    const summary = platformSummary({ platformSettings: { default: { formats: [{ name: 'png', quality: 80 }] } } }, ['minigame']);
    assert.equal(summary[0].configured, false);
    assert.equal(summary[0].inherited, true);
    assert.match(summary[0].text, /继承默认/);
});

test('路径限制在 assets；兼容 SpriteFrame 子资源与大小写扩展', () => {
    assert.equal(normalizeUrl('db://assets/ui/A.JPG/spriteFrame'), 'db://assets/ui/A.JPG');
    assert.equal(normalizeUrl('db://assets/ui/A.JPG/A'), 'db://assets/ui/A.JPG');
    assert.throws(() => normalizeUrl('db://internal/a.png'), /当前工程/);
    assert.throws(() => normalizeUrl('db://assets/../a.png'), /当前工程/);
});

test('检索单张 JPG 能发现范围外上级图集，重叠目录与子资源不会重复', async () => {
    const db = mockDb([asset('ui/ui.pac'), asset('ui/nested/a.jpg')]);
    const service = createService(db.db);
    const result = await service.scan(['db://assets/ui/nested/a.jpg'], defaults);
    assert.equal(result.stats.atlases, 1);
    assert.equal(result.stats.covered, 1);
    assert.match(result.rows.find(row => row.kind === 'atlas').reason, /范围外/);
    const overlapping = await service.scan(['db://assets/ui', 'db://assets/ui/nested'], defaults);
    assert.equal(overlapping.roots.length, 1);
    assert.equal(overlapping.rows.length, 2);
});

test('按源图片筛选仍配置 JPG 所属图集，单独选择 pac 不变成目录查询', async () => {
    const db = mockDb([asset('ui/ui.pac'), asset('ui/a.png'), asset('ui/b.jpg')]);
    const service = createService(db.db);
    const result = await service.scan(['db://assets/ui'], { ...defaults, sourceType: 'jpg' });
    assert.equal(result.rows.length, 2);
    assert.ok(result.rows.some(row => row.kind === 'atlas'));
    const single = await service.scan(['db://assets/ui/ui.pac'], defaults);
    assert.equal(single.rows.length, 1);
    assert.ok(!db.calls.some(call => call.pattern.includes('.pac/**/*')));
});

test('显式选择单个图集时，可以直接配置，不因同目录其他图集阻塞', async () => {
    const db = mockDb([asset('ui/a.pac'), asset('ui/b.pac')]);
    const result = await createService(db.db).scan(['db://assets/ui/a.pac'], defaults);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].eligible, true);
});

test('单文件通过 UUID 映射定位；Meta 查询失败不产生可写计划', async () => {
    const fallback = mockDb([asset('a.jpg')], { emptyQuery: true });
    assert.equal((await createService(fallback.db).scan(['db://assets/a.jpg'], defaults)).stats.jpg, 1);
    const broken = mockDb([asset('ui/ui.pac'), asset('ui/a.png')], { readFailure: 'ui/ui.pac' });
    await assert.rejects(createService(broken.db).scan(['db://assets/ui'], defaults), /检索不完整/);
    assert.equal(broken.writes.length, 0);
});

test('应用只保存图集和独立图片，保留其他平台及导入参数，保存串行且幂等', async () => {
    const initial = [asset('ui/ui.pac'), asset('ui/a.png'), asset('bg.jpg', { wrapMode: 'repeat', platformSettings: { web: { formats: [{ name: 'webp', quality: 90 }] } } })];
    const db = mockDb(initial), service = createService(db.db);
    const scan = await service.scan(['db://assets'], defaults);
    const result = await service.write(scan.rows, ['minigame'], defaults, 'apply');
    assert.equal(result.changed, 2);
    assert.equal(db.maximum(), 1);
    assert.ok(!db.writes.some(item => item.uuid === 'ui/a.png'));
    const background = db.assets.find(item => item.uuid === 'bg.jpg').meta;
    assert.equal(background.wrapMode, 'repeat');
    assert.equal(background.platformSettings.web.formats[0].name, 'webp');
    assert.equal(background.platformSettings.minigame.formats[1].name, 'jpg');
    assert.equal((await service.write(scan.rows, ['minigame'], defaults, 'apply')).unchanged, 2);
});

test('移除范围包括图集内旧配置，只移除所选平台，不需要压缩参数', async () => {
    const settings = { minigame: { formats: [{ name: 'astc_6x6' }] }, default: { formats: [{ name: 'png' }] } };
    const db = mockDb([asset('ui/ui.pac', { platformSettings: settings }), asset('ui/a.png', { platformSettings: settings })]);
    const service = createService(db.db), scan = await service.scan(['db://assets/ui'], defaults);
    const result = await service.write(scan.rows, ['minigame'], {}, 'remove');
    assert.equal(result.changed, 2);
    for (const item of db.assets) {
        assert.ok(!item.meta.platformSettings.minigame);
        assert.ok(item.meta.platformSettings.default);
    }
});

test('不为无配置资源制造空配置；保存错误与移动中的资源准确报告失败', async () => {
    const db = mockDb([asset('a.png'), asset('b.jpg')], { writeFailure: 'a.png' });
    const service = createService(db.db), scan = await service.scan(['db://assets'], defaults);
    assert.equal((await service.write(scan.rows, ['minigame'], {}, 'remove')).unchanged, 2);
    assert.equal(db.writes.length, 0);
    const result = await service.write(scan.rows, ['minigame'], defaults, 'apply');
    assert.equal(result.changed, 1);
    assert.equal(result.failed.length, 1);
    const moved = mockDb([asset('a.png')], { moved: 'a.png' });
    const failed = await createService(moved.db).write([asset('a.png')], ['minigame'], defaults, 'apply');
    assert.equal(failed.failed.length, 0); // 未加入检索计划的对象不可写。
    const target = { ...asset('a.png'), eligible: true, kind: 'png' };
    assert.equal((await createService(moved.db).write([target], ['minigame'], defaults, 'apply')).failed.length, 1);
});

test('多选1000张图片只查询共享父目录图集，主资源不重复查询 URL', async () => {
    const assets = Array.from({length:1000}, (_, index) => asset('perf/images/' + index + '.png'));
    const db = mockDb(assets);
    db.db.remote.urlToUuid = () => { throw new Error('已有选中 UUID，不应重复映射'); };
    const result = await createService(db.db).scan(assets.map(item => ({url:item.url, uuid:item.uuid})), defaults);
    assert.equal(result.rows.length, 1000);
    assert.equal(db.calls.length, 3);
    assert.ok(db.calls.every(call => call.pattern.endsWith('/*.pac')));
    assert.equal(db.requests.meta, 1000);
    assert.equal(db.requests.url, 0);
    assert.equal(db.writes.length, 0);
});

test('SpriteFrame 选中 UUID 只在转主纹理时补查 URL', async () => {
    const texture = asset('ui/a.png');
    const frame = {uuid:'frame', url:texture.url + '/a', meta:{importer:'sprite-frame',rawTextureUuid:texture.uuid}};
    const db = mockDb([texture, frame]);
    const result = await createService(db.db).scan([{url:frame.url,uuid:'frame'}], defaults);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].uuid, texture.uuid);
    assert.equal(result.rows[0].url, texture.url);
    assert.equal(db.requests.url, 1);
});

test('取消检索后停止后续 Meta 请求，不生成写入计划', async () => {
    const db = mockDb(Array.from({length:200}, (_, index) => asset('ui/' + index + '.png')));
    const signal = {aborted:false};
    await assert.rejects(createService(db.db).scan(['db://assets/ui'], defaults, progress => {
        if (progress.stage === '读取配置' && progress.done >= 5) signal.aborted = true;
    }, signal), error => error.code === 'ASTC_CANCELLED');
    assert.ok(db.requests.meta <= 13, '仅允许已有的最多8个请求结束');
    assert.equal(db.writes.length, 0);
});

test('开始前已取消时不调用 AssetDB，图集批量成员计数保持准确', async () => {
    const db = mockDb([]);
    await assert.rejects(createService(db.db).scan(['db://assets'], defaults, undefined, {aborted:true}), error => error.code === 'ASTC_CANCELLED');
    assert.equal(db.calls.length, 0);
    const assets = [];
    for (let group = 0; group < 100; group++) {
        assets.push(asset('group' + group + '/atlas.pac'));
        for (let index = 0; index < 10; index++) assets.push(asset('group' + group + '/' + index + '.jpg'));
    }
    const rows = planRecords(assets);
    assert.equal(rows.filter(row => row.ownerUuid).length, 1000);
    assert.ok(rows.filter(row => row.kind === 'atlas').every(row => row.members === 10));
});

test('并发任务失败后不再启动剩余请求', async () => {
    const { forEachLimit } = require('../lib/async-work');
    let started = 0;
    let finishPending;
    const pending = new Promise(resolve => { finishPending = resolve; });
    await assert.rejects(forEachLimit(Array.from({length:100}), 4, async (_, index) => {
        started++;
        if (index === 0) throw new Error('AssetDB request failed');
        await pending;
    }), /AssetDB request failed/);
    finishPending();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, 4);
});
