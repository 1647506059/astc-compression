const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planRecords, formatsFor, platformSummary, normalizeUrl, dimensions } = require('../lib/texture-config');
const { createService } = require('../lib/asset-service');
const { forEachLimit } = require('../lib/async-work');

const defaults = { block: '6x6', quality: 'medium', fallbackQuality: 80, sourceType: 'all' };
const clone = value => JSON.parse(JSON.stringify(value));
function asset(name, options = {}) {
    const atlas = /\.pac$/i.test(name);
    const meta = { importer: atlas ? 'auto-atlas' : 'image', uuid: name, imported: true, ver: '1.0.0',
        subMetas: atlas || options.raw ? {} : { frame: { importer: 'sprite-frame', uuid: name + '@frame',
            userData: { width: options.width || 100, height: options.height || 100, rawWidth: options.width || 100,
                rawHeight: options.height || 100, packable: options.packable !== false } } },
        userData: atlas ? { maxWidth: 1024, maxHeight: 1024, allowRotation: true, padding: 2 } : { type: options.raw ? 'texture' : 'sprite-frame' } };
    Object.assign(meta.userData, options.userData);
    return { url: 'db://assets/' + name, uuid: name, inScope: true, meta };
}

function mockEditor(input, presets = {}, flags = {}) {
    const assets = clone(input), users = clone(presets), builtin = clone(flags.builtin || {});
    const writes = [], profileWrites = [], queries = [], requests = { meta: 0, url: 0, uuid: 0 };
    let active = 0, maximum = 0, reading = 0, maxReading = 0;
    const editor = {
        Message: { async request(channel, method, ...args) {
            assert.equal(channel, 'asset-db');
            if (method === 'query-assets') {
                const { pattern, importer } = args[0]; queries.push(args[0]);
                return assets.filter(item => item.meta.importer === importer && (pattern.endsWith('/**/*') ? item.url.startsWith(pattern.slice(0, -4)) :
                    pattern.endsWith('/*.pac') ? item.url.slice(0, item.url.lastIndexOf('/')) === pattern.slice(0, -6) && /\.pac$/.test(item.url) : item.url === pattern))
                    .map(({ uuid, url }) => ({ uuid, url }));
            }
            if (method === 'query-uuid') { requests.uuid++; return (assets.find(item => item.url === args[0]) || {}).uuid || null; }
            if (method === 'query-url') { requests.url++; return flags.moved === args[0] ? 'db://assets/moved.png' : (assets.find(item => item.uuid === args[0]) || {}).url || null; }
            if (method === 'query-asset-meta') {
                requests.meta++; reading++; maxReading = Math.max(maxReading, reading);
                await new Promise(resolve => setImmediate(resolve)); reading--;
                if (flags.readFailure === args[0]) throw new Error('meta read failed');
                const item = assets.find(item => item.uuid === args[0]);
                return item ? clone(item.meta) : null;
            }
            if (method === 'save-asset-meta') {
                active++; maximum = Math.max(maximum, active);
                await new Promise(resolve => setTimeout(resolve, 1)); active--;
                if (flags.writeFailure === args[0]) throw new Error('save failed');
                if (flags.nullSave === args[0]) return null;
                const meta = JSON.parse(args[1]);
                if (flags.pendingImport) {
                    meta.imported = false;
                    setTimeout(() => { meta.imported = true; }, 20);
                }
                if (flags.dropCompression) delete meta.userData.compressSettings;
                assert.equal(meta.uuid, args[0]);
                assets.find(item => item.uuid === args[0]).meta = meta;
                writes.push({ uuid: args[0], meta });
                return { uuid: args[0] };
            }
            throw new Error('Unexpected message: ' + method);
        } },
        Profile: {
            async getProject(name, key) {
                assert.equal(name, 'builder');
                if (key === 'textureCompressConfig.userPreset') return clone(users);
                if (key === 'textureCompressConfig.defaultConfig') return clone(builtin);
                throw new Error('Unexpected profile key: ' + key);
            },
            async setProject(name, key, value) {
                assert.equal(name, 'builder');
                assert.ok(key.startsWith('textureCompressConfig.userPreset.astc-'));
                if (flags.profileFailure) throw new Error('profile save failed');
                const id = key.slice('textureCompressConfig.userPreset.'.length);
                assert.ok(!users[id], 'Shared presets must never be overwritten');
                users[id] = clone(value); profileWrites.push(id);
            },
        },
    };
    return { editor, assets, users, writes, profileWrites, queries, requests, maximum: () => maximum,
        maxReading: () => maxReading, preset: name => ({ ...builtin, ...users })[assets.find(item => item.uuid === name).meta.userData.compressSettings?.presetId] };
}
const compressed = presetId => ({ compressSettings: { useCompressTexture: true, presetId } });
const shared = { name: 'Existing', options: { miniGame: { png: { quality: 60 } }, web: { webp: { quality: 90 } } },
    overwrite: { wechatgame: { png: { quality: 50 } }, 'web-mobile': { webp: { quality: 70 } } } };

test('图集优先，独立 PNG/JPG/JPEG 都可配置；目录有边界且选择最近图集', () => {
    const rows = planRecords([asset('ui/ui.pac'), asset('ui/nested/atlas.pac'), asset('ui/a.png'), asset('ui/nested/b.JPG'), asset('ui2/c.jpeg')]);
    assert.equal(rows.find(row => row.url.endsWith('/c.jpeg')).eligible, true);
    assert.equal(rows.find(row => row.url.endsWith('/b.JPG')).ownerUuid, 'ui/nested/atlas.pac');
    assert.equal(rows.filter(row => row.eligible).length, 3);
});

test('3.8 图片从 SpriteFrame 子 Meta 读取尺寸，非 Sprite/禁止合图/超大图独立配置', () => {
    const rows = planRecords([asset('ui/atlas.pac'), asset('ui/raw.png', { raw: true }), asset('ui/no.png', { packable: false }), asset('ui/large.jpg', { height: 2048 }), asset('ui/fit.png')]);
    assert.equal(rows.filter(row => row.eligible && row.kind !== 'atlas').length, 3);
    assert.deepEqual(dimensions(rows.find(row => row.url.endsWith('/fit.png')).meta), { width: 100, height: 100 });
});

test('多个图集暂停自动归属，显式选中单个图集仍可操作', async () => {
    const input = [asset('ui/a.pac'), asset('ui/b.pac'), asset('ui/a.png')];
    assert.ok(planRecords(input).every(row => row.conflict && !row.eligible));
    const db = mockEditor(input);
    const result = await createService(db.editor).scan(['db://assets/ui/a.pac']);
    assert.equal(result.rows.length, 1); assert.equal(result.rows[0].eligible, true);
});

test('PNG/图集保留 PNG 回退，JPG 使用 JPG 回退，拒绝非法参数', () => {
    for (const kind of ['png', 'atlas']) assert.equal(formatsFor({ kind }, defaults)[1].name, 'png');
    assert.equal(formatsFor({ kind: 'jpg' }, defaults)[1].name, 'jpg');
    for (const value of ['', -1, 101, 1.1]) assert.throws(() => formatsFor({ kind: 'png' }, { ...defaults, fallbackQuality: value }), /0–100/);
    assert.throws(() => formatsFor({ kind: 'png' }, { ...defaults, block: '99x99' }), /无效/);
});

test('路径限制在 assets 并归一化图片子资源 URL', () => {
    assert.equal(normalizeUrl('db://assets/ui/A.JPG/spriteFrame'), 'db://assets/ui/A.JPG');
    assert.throws(() => normalizeUrl('db://internal/a.png'), /当前工程/);
    assert.throws(() => normalizeUrl('db://assets/../a.png'), /当前工程/);
});

test('单图检索发现上级图集，重叠目录合并，源 JPG 筛选仍包含其图集', async () => {
    const db = mockEditor([asset('ui/a.pac'), asset('ui/nested/a.jpg'), asset('ui/b.png')]);
    const service = createService(db.editor);
    const single = await service.scan(['db://assets/ui/nested/a.jpg']);
    assert.equal(single.stats.covered, 1); assert.match(single.rows.find(row => row.kind === 'atlas').reason, /范围外/);
    const result = await service.scan(['db://assets/ui', 'db://assets/ui/nested'], { sourceType: 'jpg' });
    assert.equal(result.roots.length, 1); assert.equal(result.rows.length, 2);
    assert.ok(db.queries.every(query => ['image', 'auto-atlas'].includes(query.importer)));
});

test('SpriteFrame/Texture 的 @ 子资源 UUID 仅写主 image Meta', async () => {
    const db = mockEditor([asset('a.png')]);
    const service = createService(db.editor);
    const result = await service.scan([{ url: 'db://assets/a.png/spriteFrame', uuid: 'a.png@frame' }, { url: 'db://assets/a.png/texture', uuid: 'a.png@texture' }]);
    assert.equal(result.rows.length, 1); assert.equal(result.rows[0].uuid, 'a.png');
    await service.write(result.rows, ['miniGame'], defaults, 'apply');
    assert.equal(db.writes[0].uuid, 'a.png'); assert.equal(db.assets[0].meta.subMetas.frame.uuid, 'a.png@frame');
});

test('应用保留其他分组、平台覆盖、导入参数与 UUID；共享预设和未勾选资源不变', async () => {
    const db = mockEditor([asset('a.png', { userData: { ...compressed('shared'), custom: 42 } }), asset('b.png', { userData: compressed('shared') })], { shared });
    const service = createService(db.editor), result = await service.scan(['db://assets/a.png']);
    const before = clone(db.assets[0].meta), untouched = clone(db.assets[1]);
    assert.equal((await service.write(result.rows, ['miniGame'], defaults, 'apply')).changed, 1);
    assert.deepEqual(db.users.shared, shared); assert.deepEqual(db.assets[1], untouched);
    assert.deepEqual(db.preset('a.png').options.web, shared.options.web);
    assert.deepEqual(db.preset('a.png').overwrite['web-mobile'], shared.overwrite['web-mobile']);
    assert.equal(db.preset('a.png').overwrite.wechatgame.astc_6x6.quality, 'medium');
    assert.equal(db.assets[0].meta.userData.custom, 42);
    delete before.userData.compressSettings;
    const after = clone(db.assets[0].meta); delete after.userData.compressSettings;
    assert.deepEqual(after, before);
});

test('应用只保存图集和独立图片，串行保存、同配置复用预设并保持幂等', async () => {
    const db = mockEditor([asset('ui/a.pac'), asset('ui/a.png'), asset('a.png'), asset('b.png'), asset('c.jpg')]);
    const service = createService(db.editor), result = await service.scan(['db://assets']);
    assert.equal((await service.write(result.rows, ['miniGame'], defaults, 'apply')).changed, 4);
    assert.equal(db.maximum(), 1); assert.equal(db.profileWrites.length, 2);
    assert.ok(!db.writes.some(item => item.uuid === 'ui/a.png'));
    assert.ok(db.preset('a.png').options.miniGame.png); assert.ok(db.preset('c.jpg').options.miniGame.jpg);
    assert.equal((await service.write(result.rows, ['miniGame'], defaults, 'apply')).unchanged, 4);
    assert.equal(db.writes.length, 4);
});

test('移除包括图集内遗留配置，仅移除所选分组及其平台覆盖', async () => {
    const db = mockEditor([asset('ui/a.pac', { userData: compressed('shared') }), asset('ui/a.png', { userData: compressed('shared') })], { shared });
    const service = createService(db.editor), result = await service.scan(['db://assets/ui']);
    assert.equal((await service.write(result.rows, ['miniGame'], {}, 'remove')).changed, 2);
    for (const item of db.assets) {
        const preset = db.preset(item.uuid);
        assert.ok(!preset.options.miniGame); assert.ok(!preset.overwrite.wechatgame);
        assert.deepEqual(preset.options.web, shared.options.web);
    }
    assert.deepEqual(db.users.shared, shared); assert.equal(db.profileWrites.length, 1);
});

test('移除最后一个分组关闭压缩；未配置或已禁用的资源不制造空预设', async () => {
    const db = mockEditor([asset('a.png', { userData: compressed('single') }), asset('b.png'), asset('c.png', { userData: { compressSettings: { useCompressTexture: false, presetId: 'missing' } } })],
        { single: { name: 'Only', options: { miniGame: { png: { quality: 80 } } } } });
    const service = createService(db.editor), result = await service.scan(['db://assets']);
    const removed = await service.write(result.rows, ['miniGame'], {}, 'remove');
    assert.equal(removed.changed, 1); assert.equal(removed.unchanged, 2);
    assert.ok(!db.assets[0].meta.userData.compressSettings); assert.equal(db.profileWrites.length, 0);
});

test('支持内置预设副本，禁用的旧预设不会意外恢复其他平台', async () => {
    const db = mockEditor([asset('a.png', { userData: compressed('default') }), asset('b.png', { userData: { compressSettings: { useCompressTexture: false, presetId: 'default' } } })], {}, { builtin: { default: shared } });
    const service = createService(db.editor), result = await service.scan(['db://assets']);
    assert.equal((await service.write(result.rows, ['miniGame'], defaults, 'apply')).changed, 2);
    assert.ok(db.preset('a.png').options.web); assert.ok(!db.preset('b.png').options.web);
});

test('失效预设不会悄悄丢失未知平台；预设写失败不会继续写资源 Meta', async () => {
    for (const flags of [{ missing: true }, { profileFailure: true }]) {
        const db = mockEditor([asset('a.png', { userData: flags.missing ? compressed('missing') : {} })], {}, flags);
        const service = createService(db.editor), result = await service.scan(['db://assets']);
        assert.equal((await service.write(result.rows, ['miniGame'], defaults, 'apply')).failed.length, 1);
        assert.equal(db.writes.length, 0);
    }
});

test('已删除图集导致检索不完整时拒绝计划，保存失败/返回空值/移动资源分别报告', async () => {
    const broken = mockEditor([asset('ui/a.pac'), asset('ui/a.png')], {}, { readFailure: 'ui/a.pac' });
    await assert.rejects(createService(broken.editor).scan(['db://assets']), /检索不完整/);
    assert.equal(broken.writes.length, 0);
    for (const flag of ['writeFailure', 'nullSave', 'moved']) {
        const db = mockEditor([asset('a.png'), asset('b.jpg')], {}, { [flag]: 'a.png' });
        const service = createService(db.editor), result = await service.scan(['db://assets']);
        const applied = await service.write(result.rows, ['miniGame'], defaults, 'apply');
        assert.equal(applied.failed.length, 1); assert.equal(applied.changed, 1);
    }
});

test('平台摘要显示 3.8 预设和覆盖配置，禁用配置不误报', () => {
    const row = { ...asset('a.png', { userData: compressed('shared') }), preset: shared };
    assert.match(platformSummary(row, ['miniGame'])[0].text, /wechatgame/);
    assert.equal(platformSummary(row, ['ios'])[0].configured, false);
    row.meta.userData.compressSettings.useCompressTexture = false;
    assert.equal(platformSummary(row, ['miniGame'])[0].configured, false);
});

test('保存消息提前返回时等待导入完成，保存后压缩引用丢失不能报成功', async () => {
    const db = mockEditor([asset('a.png')], {}, { pendingImport: true });
    const service = createService(db.editor), result = await service.scan(['db://assets']);
    assert.equal((await service.write(result.rows, ['miniGame'], defaults, 'apply')).changed, 1);
    assert.equal(db.assets[0].meta.imported, true);
    const broken = mockEditor([asset('a.png')], {}, { dropCompression: true });
    const other = createService(broken.editor), scan = await other.scan(['db://assets']);
    assert.equal((await other.write(scan.rows, ['miniGame'], defaults, 'apply')).failed.length, 1);
});

test('1000张多选图片复用UUID，只查共享父图集；Meta 并发不超过8', async () => {
    const input = Array.from({ length: 1000 }, (_, index) => asset('perf/images/' + index + '.png'));
    const db = mockEditor(input), result = await createService(db.editor).scan(input.map(({ uuid, url }) => ({ uuid, url })));
    assert.equal(result.rows.length, 1000); assert.equal(db.queries.length, 3);
    assert.equal(db.requests.meta, 1000); assert.equal(db.requests.url, 0); assert.equal(db.requests.uuid, 0);
    assert.ok(db.maxReading() <= 8); assert.equal(db.writes.length, 0);
});

test('取消检索停止后续读取，不生成可写计划；开始前取消不调用AssetDB', async () => {
    const db = mockEditor(Array.from({ length: 200 }, (_, index) => asset('ui/' + index + '.png')));
    const signal = { aborted: false };
    await assert.rejects(createService(db.editor).scan(['db://assets'], defaults, info => {
        if (info.stage === '读取配置' && info.done >= 5) signal.aborted = true;
    }, signal), error => error.code === 'ASTC_CANCELLED');
    assert.ok(db.requests.meta <= 13); assert.equal(db.writes.length, 0);
    const empty = mockEditor([]);
    await assert.rejects(createService(empty.editor).scan(['db://assets'], defaults, undefined, signal), error => error.code === 'ASTC_CANCELLED');
    assert.equal(empty.queries.length, 0);
});

test('并发读取失败不再启动剩余任务', async () => {
    let started = 0, release;
    const pending = new Promise(resolve => { release = resolve; });
    await assert.rejects(forEachLimit(Array.from({ length: 100 }), 4, async (_, index) => {
        started++; if (!index) throw new Error('request failed'); await pending;
    }), /request failed/);
    release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(started, 4);
});
