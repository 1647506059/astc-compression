'use strict';

const PLATFORMS = [
    { id: 'minigame', label: '小游戏' }, { id: 'android', label: 'Android' },
    { id: 'ios', label: 'iOS' }, { id: 'web', label: 'Web' }, { id: 'default', label: '默认' },
];
const BLOCKS = ['4x4', '6x6', '8x8'];
const QUALITIES = ['fast', 'medium', 'thorough'];

function normalizeUrl(value) {
    const url = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!/^db:\/\/assets(?:\/|$)/.test(url) || url.split('/').some(part => part === '..' || part === '.')) {
        throw new Error('请选择当前工程 assets 内的资源或目录。');
    }
    return url.replace(/\.(png|jpe?g)\/[^/]+$/i, '.$1');
}

function within(url, root) { return url === root || url.startsWith(root + '/'); }
function parent(url) { return url.slice(0, url.lastIndexOf('/')); }
function imageType(url) {
    const match = url.match(/\.(png|jpe?g)$/i);
    return match ? (match[1].toLowerCase() === 'png' ? 'png' : 'jpg') : '';
}

function formatsFor(record, options) {
    if (!BLOCKS.includes(options.block) || !QUALITIES.includes(options.quality)) throw new Error('无效的 ASTC 参数。');
    const quality = Number(options.fallbackQuality);
    if (options.fallbackQuality == null || String(options.fallbackQuality).trim() === '' || !Number.isInteger(quality) || quality < 0 || quality > 100) throw new Error('回退图质量必须为 0–100 的整数。');
    // 图集可能含透明像素；只允许 JPG 原图使用 JPG 回退。
    return [{ name: 'astc_' + options.block, quality: options.quality },
        { name: record.kind === 'jpg' ? 'jpg' : 'png', quality }];
}

function platformSummary(meta, platforms) {
    const settings = meta.platformSettings || {};
    return platforms.map(id => {
        const own = settings[id];
        const inherited = !own && id !== 'default' && settings.default;
        const formats = (own || inherited || {}).formats || [];
        const value = formats.map(item => item.name + (item.quality == null ? '' : ' · ' + item.quality)).join(' + ');
        return { platform: id, configured: !!own, inherited: !!inherited,
            text: value ? (inherited ? '继承默认：' : '') + value : own ? '空配置' : '原图 / 未配置' };
    });
}

function atlasFits(image, atlas) {
    const frames = Object.values(image.subMetas || {}).filter(meta => meta.importer === 'sprite-frame');
    const width = frames.length ? Math.max(...frames.map(meta => Number(meta.width) || 0)) : Number(image.width);
    const height = frames.length ? Math.max(...frames.map(meta => Number(meta.height) || 0)) : Number(image.height);
    const maxWidth = Number(atlas.maxWidth), maxHeight = Number(atlas.maxHeight);
    if (!width || !height || !maxWidth || !maxHeight) return true;
    return width <= maxWidth && height <= maxHeight || !!atlas.allowRotation && height <= maxWidth && width <= maxHeight;
}

function planRecords(assets, options = {}) {
    const sourceType = options.sourceType || 'all';
    const atlases = assets.filter(asset => asset.meta.importer === 'auto-atlas');
    const images = assets.filter(asset => asset.meta.importer === 'texture' && imageType(asset.url));
    const atlasDirs = new Map();
    for (const atlas of atlases) {
        const dir = parent(atlas.url);
        if (!atlasDirs.has(dir)) atlasDirs.set(dir, []);
        atlasDirs.get(dir).push(atlas);
    }
    const rows = [], used = new Map(), ownerCache = new Map();
    function ownersFor(url) {
        const directory = parent(url);
        if (ownerCache.has(directory)) return ownerCache.get(directory);
        let dir = directory;
        while (within(dir, 'db://assets')) {
            if (atlasDirs.has(dir)) break;
            if (dir === 'db://assets') break;
            dir = parent(dir);
        }
        const owners = atlasDirs.get(dir) || [];
        ownerCache.set(directory, owners);
        return owners;
    }
    function atlasRow(atlas, reason) {
        if (used.has(atlas.uuid)) return used.get(atlas.uuid);
        const row = { ...atlas, kind: 'atlas', eligible: true, reason, members: 0 };
        used.set(atlas.uuid, row);
        rows.push(row);
        return row;
    }
    // 检索全部格式时，即使图集当前没有图片，也可以配置/移除其配置。
    for (const atlas of atlases) {
        if (atlas.inScope && (sourceType === 'all' || atlas.explicit)) atlasRow(atlas, '配置图集，图集内碎图不重复写入');
    }
    for (const image of images) {
        const kind = imageType(image.url);
        if (!image.inScope || sourceType !== 'all' && sourceType !== kind) continue;
        const candidates = ownersFor(image.url);
        let owner = candidates[0];
        let reason = '无自动图集，配置源图片';
        const sprite = image.meta.type ? image.meta.type === 'sprite' : Object.values(image.meta.subMetas || {}).some(meta => meta.importer === 'sprite-frame');
        if (!sprite) { owner = null; reason = '非 Sprite 纹理，按独立图片配置'; }
        else if (candidates.length > 1) {
            rows.push({ ...image, kind, eligible: false, conflict: true, reason: '同一目录存在多个自动图集，请先整理图集归属' });
            continue;
        } else if (owner && !atlasFits(image.meta, owner.meta)) {
            owner = null; reason = '图片超出图集尺寸，作为碎图配置';
        }
        if (owner) {
            atlasRow(owner, owner.inScope ? '配置图集，图集内碎图不重复写入' : '由上级目录图集接管（图集位于所选范围外）').members++;
            rows.push({ ...image, kind, eligible: false, ownerUuid: owner.uuid, ownerUrl: owner.url,
                reason: '跟随图集：' + owner.url.split('/').pop() });
        } else rows.push({ ...image, kind, eligible: true, reason });
    }
    for (const row of rows.filter(item => item.kind === 'atlas')) {
        if (!row.explicit && (atlasDirs.get(parent(row.url)) || []).length > 1) {
            row.eligible = false; row.conflict = true; row.reason = '同目录多个自动图集，暂停自动配置';
        }
    }
    return rows.sort((a, b) => a.url.localeCompare(b.url));
}

module.exports = { PLATFORMS, BLOCKS, QUALITIES, normalizeUrl, within, parent, imageType,
    formatsFor, platformSummary, planRecords };
