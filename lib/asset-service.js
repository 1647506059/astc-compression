'use strict';

const { normalizeUrl, within, parent, imageType, formatsFor, PLATFORMS, planRecords } = require('./texture-config');
const { forEachLimit, checkCancelled } = require('./async-work');
const { signature, resolvePreset, changePreset, hasFormats, ensurePreset } = require('./presets');

function inScope(url, roots) {
    let current = url;
    while (within(current, 'db://assets')) {
        if (roots.has(current)) return true;
        if (current === 'db://assets') break;
        current = parent(current);
    }
    return false;
}

function createService(editor) {
    const call = (method, ...args) => editor.Message.request('asset-db', method, ...args);

    async function read(uuid, signal) {
        const mainUuid = String(uuid).split('@')[0];
        const deadline = Date.now() + 15000;
        while (true) {
            checkCancelled(signal);
            const meta = await call('query-asset-meta', mainUuid);
            if (!meta || typeof meta !== 'object' || meta.uuid !== mainUuid) throw new Error('无法读取主资源 Meta：' + mainUuid);
            if (meta.imported !== false) return { uuid: mainUuid, meta };
            if (Date.now() >= deadline) throw new Error('资源重导入未完成，请稍后重新检索：' + mainUuid);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    async function loadPresets() {
        const [defaults, users] = await Promise.all([
            editor.Profile.getProject('builder', 'textureCompressConfig.defaultConfig'),
            editor.Profile.getProject('builder', 'textureCompressConfig.userPreset'),
        ]);
        return { ...defaults, ...users };
    }

    async function scan(inputRoots, options = {}, progress = () => {}, signal) {
        checkCancelled(signal);
        const selected = inputRoots.map(item => typeof item === 'string' ? { url: normalizeUrl(item) } : { url: normalizeUrl(item.url), uuid: item.uuid });
        const rootSet = new Set(selected.map(item => item.url));
        const roots = [...rootSet].filter(url => url === 'db://assets' || !inScope(parent(url), rootSet));
        if (!roots.length) throw new Error('请先选择资源或目录。');
        const presets = await loadPresets();
        const scopes = new Set(roots);
        const directories = new Set(roots.filter(url => !/\.(pac|png|jpe?g)$/i.test(url)));
        const selectedUuids = new Map(selected.filter(item => item.uuid).map(item => [item.url, item.uuid]));
        const candidates = new Map(), queried = new Map(), cache = new Map();
        async function query(pattern, importer) {
            checkCancelled(signal);
            const key = pattern + '|' + importer;
            if (!queried.has(key)) queried.set(key, call('query-assets', { pattern, importer }).then(result => result || []));
            return queried.get(key);
        }
        function add(assets) {
            for (const asset of assets) {
                if (!asset.uuid || !asset.url) continue;
                const url = normalizeUrl(asset.url);
                if (/\.pac$/i.test(url) || imageType(url)) {
                    const uuid = asset.uuid.split('@')[0];
                    candidates.set(uuid, { uuid, url });
                }
            }
        }
        const queries = [], ancestors = new Set();
        let prepared = 0;
        await forEachLimit(roots, 1, async root => {
            const file = /\.(pac|png|jpe?g)$/i.test(root);
            if (file) {
                const uuid = selectedUuids.get(root) || await call('query-uuid', root);
                if (!uuid) throw new Error('资源未导入或已不存在：' + root);
                add([{ uuid, url: root }]);
            } else for (const importer of ['auto-atlas', 'image']) queries.push({ pattern: root + '/**/*', importer });
            let dir = file ? parent(root) : root;
            while (within(dir, 'db://assets')) {
                if (!directories.size || !inScope(dir, directories)) ancestors.add(dir);
                if (dir === 'db://assets') break;
                dir = parent(dir);
            }
            progress({ phase: 'scan', stage: '准备路径', done: ++prepared, total: roots.length });
        }, signal);
        for (const dir of ancestors) queries.push({ pattern: dir + '/*.pac', importer: 'auto-atlas' });
        let queriedCount = 0;
        await forEachLimit(queries, 4, async item => {
            add(await query(item.pattern, item.importer));
            progress({ phase: 'scan', stage: '查询资源', done: ++queriedCount, total: queries.length });
        }, signal);
        const found = [...candidates.values()], assets = [], errors = [];
        let finished = 0;
        await forEachLimit(found, 8, async candidate => {
            try {
                if (!cache.has(candidate.uuid)) cache.set(candidate.uuid, read(candidate.uuid, signal));
                const current = await cache.get(candidate.uuid);
                checkCancelled(signal);
                assets.push({ ...current, url: candidate.url, inScope: inScope(candidate.url, scopes), explicit: scopes.has(candidate.url),
                    preset: resolvePreset(current.meta, presets) });
            } catch (error) { errors.push({ url: candidate.url, message: error.message }); }
            progress({ phase: 'scan', stage: '读取配置', done: ++finished, total: found.length });
        }, signal);
        checkCancelled(signal);
        if (errors.length) throw new Error('检索不完整，未生成写入计划：\n' + errors.map(error => error.url + '：' + error.message).join('\n'));
        const rows = planRecords(assets, options);
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
                const url = normalizeUrl(await call('query-url', current.uuid));
                if (url !== row.url || !['image', 'auto-atlas'].includes(current.meta.importer)) throw new Error('资源身份已变化，请重新检索。');
                const meta = current.meta;
                const presets = await loadPresets();
                const base = resolvePreset(meta, presets, true);
                const preset = changePreset(base, row, platforms, options, action);
                if (signature(base) === signature(preset)) { result.unchanged++; }
                else {
                    meta.userData = meta.userData || {};
                    if (hasFormats(preset)) {
                        const presetId = await ensurePreset(editor, preset);
                        meta.userData.compressSettings = { ...meta.userData.compressSettings, useCompressTexture: true, presetId };
                    } else delete meta.userData.compressSettings;
                    const saved = await call('save-asset-meta', current.uuid, JSON.stringify(meta));
                    if (!saved) throw new Error('资源 Meta 保存未成功，请重新检索。');
                    // 3.8 的保存消息先返回，再异步重导入；完成后读回压缩引用。
                    const verified = (await read(current.uuid)).meta.userData.compressSettings;
                    const expected = meta.userData.compressSettings;
                    if (expected ? !verified || !verified.useCompressTexture || verified.presetId !== expected.presetId : verified && verified.useCompressTexture) {
                        throw new Error('保存后的压缩配置与预期不一致，请重新检索。');
                    }
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
