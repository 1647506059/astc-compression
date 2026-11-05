'use strict';

const { normalizeUrl, within, parent, imageType, formatsFor, PLATFORMS, planRecords } = require('./texture-config');
const { forEachLimit, checkCancelled } = require('./async-work');

function inScope(url, roots) {
    let current = url;
    while (within(current, 'db://assets')) {
        if (roots.has(current)) return true;
        if (current === 'db://assets') break;
        current = parent(current);
    }
    return false;
}

function createService(assetdb) {
    function call(method, ...args) {
        return new Promise((resolve, reject) => {
            assetdb[method](...args, (error, result) => error ? reject(new Error(String(error.message || error))) : resolve(result));
        });
    }

    async function read(uuid) {
        const result = await call('queryMetaInfoByUuid', uuid);
        if (!result || !result.json) throw new Error('无法读取资源 Meta：' + uuid);
        const meta = JSON.parse(result.json);
        return meta.importer === 'sprite-frame' && meta.rawTextureUuid ? read(meta.rawTextureUuid) : { uuid: meta.uuid || uuid, meta };
    }

    async function scan(inputRoots, options, progress = () => {}, signal) {
        checkCancelled(signal);
        const selected = inputRoots.map(item => typeof item === 'string' ? { url: normalizeUrl(item) } : { url: normalizeUrl(item.url), uuid: item.uuid });
        const rootSet = new Set(selected.map(item => item.url));
        const roots = [...rootSet].filter(url => url === 'db://assets' || !inScope(parent(url), rootSet));
        if (!roots.length) throw new Error('请先选择资源或目录。');
        const scopes = new Set(roots);
        const directories = new Set(roots.filter(url => !/\.(pac|png|jpe?g)$/i.test(url)));
        const selectedUuids = new Map(selected.filter(item => item.uuid).map(item => [item.url, item.uuid]));
        const candidates = new Map(), queried = new Map(), cache = new Map();
        async function query(pattern, type) {
            checkCancelled(signal);
            const key = pattern + '|' + type;
            if (!queried.has(key)) queried.set(key, call('queryAssets', pattern, type).then(result => result || []));
            return queried.get(key);
        }
        function add(assets) {
            for (const asset of assets) {
                if (!asset.uuid || !asset.url) continue;
                const url = normalizeUrl(asset.url);
                if (/\.pac$/i.test(url) || imageType(url)) candidates.set(asset.uuid, { uuid: asset.uuid, url });
            }
        }
        const queries = [], ancestors = new Set();
        let prepared = 0;
        await forEachLimit(roots, 1, async root => {
            const file = /\.(pac|png|jpe?g)$/i.test(root);
            if (file) {
                // 单文件已有 UUID 映射，不再对每张图片执行两次全库 glob 查询。
                const uuid = selectedUuids.get(root) || assetdb.remote.urlToUuid(root);
                if (!uuid) throw new Error('资源未导入或已不存在：' + root);
                add([{ uuid, url: root }]);
            } else for (const type of ['auto-atlas', 'texture']) queries.push({ pattern: root + '/**/*', type });
            // 选择单图或图集子目录时仍查询父级图集，防止误把图集成员配置成碎图。
            let dir = file ? parent(root) : root;
            while (within(dir, 'db://assets')) {
                if (!directories.size || !inScope(dir, directories)) ancestors.add(dir);
                if (dir === 'db://assets') break;
                dir = parent(dir);
            }
            progress({ phase: 'scan', stage: '准备路径', done: ++prepared, total: roots.length });
        }, signal);
        for (const dir of ancestors) queries.push({ pattern: dir + '/*.pac', type: 'auto-atlas' });
        let queriedCount = 0;
        await forEachLimit(queries, 4, async item => {
            add(await query(item.pattern, item.type));
            progress({ phase: 'scan', stage: '查询资源', done: ++queriedCount, total: queries.length });
        }, signal);
        const found = [...candidates.values()], assets = [], errors = [];
        let finished = 0;
        await forEachLimit(found, 8, async candidate => {
            try {
                if (!cache.has(candidate.uuid)) cache.set(candidate.uuid, read(candidate.uuid));
                const current = await cache.get(candidate.uuid);
                checkCancelled(signal);
                // 查询结果已带主资源 URL；仅 SpriteFrame 转主纹理时需要补查 URL。
                const url = current.uuid === candidate.uuid ? candidate.url : normalizeUrl(await call('queryUrlByUuid', current.uuid));
                assets.push({ ...current, url, inScope: inScope(url, scopes), explicit: scopes.has(url) });
            } catch (error) { errors.push({ url: candidate.url, message: error.message }); }
            progress({ phase: 'scan', stage: '读取配置', done: ++finished, total: found.length });
        }, signal);
        checkCancelled(signal);
        const unique = [...new Map(assets.map(asset => [asset.uuid, asset])).values()];
        // 图集读取失败时不能静默降级为碎图，否则可能批量写错配置。
        if (errors.length) throw new Error('检索不完整，未生成写入计划：\n' + errors.map(error => error.url + '：' + error.message).join('\n'));
        const rows = planRecords(unique, options);
        return { roots, rows, stats: {
            atlases: rows.filter(row => row.kind === 'atlas').length,
            png: rows.filter(row => row.kind === 'png' && row.eligible).length,
            jpg: rows.filter(row => row.kind === 'jpg' && row.eligible).length,
            covered: rows.filter(row => row.ownerUuid).length,
            conflicts: rows.filter(row => row.conflict).length,
        } };
    }

    async function write(rows, platforms, options, action, progress = () => {}) {
        if (!platforms.length || platforms.some(id => !PLATFORMS.some(platform => platform.id === id))) throw new Error('请选择有效平台。');
        if (!['apply', 'remove'].includes(action)) throw new Error('无效操作。');
        const targets = [...new Map(rows.filter(row => action === 'remove' || row.eligible).map(row => [row.uuid, row])).values()];
        if (action === 'apply') targets.forEach(row => formatsFor(row, options));
        const result = { changed: 0, unchanged: 0, failed: [], total: targets.length };
        for (const row of targets) {
            try {
                const current = await read(row.uuid);
                const url = normalizeUrl(await call('queryUrlByUuid', current.uuid));
                if (url !== row.url || !['texture', 'auto-atlas'].includes(current.meta.importer)) throw new Error('资源身份已变化，请重新检索。');
                const meta = current.meta;
                const before = JSON.stringify(meta.platformSettings || {});
                if (action === 'apply') {
                    meta.platformSettings = meta.platformSettings || {};
                    for (const platform of platforms) {
                        meta.platformSettings[platform] = Object.assign({}, meta.platformSettings[platform], { formats: formatsFor(row, options) });
                    }
                } else if (meta.platformSettings) {
                    for (const platform of platforms) delete meta.platformSettings[platform];
                }
                if (JSON.stringify(meta.platformSettings || {}) === before) result.unchanged++;
                else {
                    await call('saveMeta', current.uuid, JSON.stringify(meta));
                    result.changed++;
                }
            } catch (error) { result.failed.push({ url: row.url, message: error.message }); }
            progress({ phase: action, done: result.changed + result.unchanged + result.failed.length, total: targets.length });
        }
        return result;
    }

    return { scan, write, read };
}

module.exports = { createService };
