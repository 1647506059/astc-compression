'use strict';

const PLATFORMS = [
    { id: 'miniGame', label: '小游戏' }, { id: 'android', label: 'Android' },
    { id: 'ios', label: 'iOS' }, { id: 'web', label: 'Web' },
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

// 3.8 的压缩设置在主 image / auto-atlas 上，图片子资源只用于分类和尺寸。
function dimensions(meta) {
    if (meta.importer === 'auto-atlas') return { width: meta.userData.maxWidth, height: meta.userData.maxHeight };
    const frame = Object.values(meta.subMetas || {}).find(item => item.importer === 'sprite-frame');
    const data = frame && frame.userData || meta.userData || {};
    return { width: data.rawWidth || data.width, height: data.rawHeight || data.height };
}

function overrideGroup(platform) {
    if (platform === 'miniGame' || platform === 'wechatgame' || /(?:mini-game|quick-game|instant-games)$/.test(platform)) return 'miniGame';
    if (platform === 'web-mobile' || platform === 'web-desktop') return 'web';
    if (platform === 'huawei-agc') return 'android';
    return platform;
}

function formatSummary(formats) {
    return Object.entries(formats || {}).map(([name, value]) => name + (value.quality == null ? '' : ' · ' + value.quality)).join(' + ');
}

function platformSummary(row, platforms) {
    const settings = row.meta.userData && row.meta.userData.compressSettings;
    const preset = row.preset;
    return platforms.map(id => {
        if (!settings || !settings.useCompressTexture) return { platform: id, configured: false, text: '原图 / 未配置' };
        if (!preset) return { platform: id, configured: true, text: '预设已失效：' + (settings.presetId || '未指定') };
        const overrides = Object.entries(preset.overwrite || {}).filter(([key, value]) => overrideGroup(key) === id && Object.keys(value || {}).length);
        const value = formatSummary((preset.options || {})[id]);
        return { platform: id, configured: !!value || overrides.length > 0,
            text: (value || '原图 / 未配置') + (overrides.length ? '；平台覆盖：' + overrides.map(([key, formats]) => key + ' [' + formatSummary(formats) + ']').join('，') : '') };
    });
}

function atlasFits(image, atlas) {
    const frames = Object.values(image.subMetas || {}).filter(meta => meta.importer === 'sprite-frame');
    const width = frames.length ? Math.max(...frames.map(meta => Number(meta.userData.width) || 0)) : Number(dimensions(image).width);
    const height = frames.length ? Math.max(...frames.map(meta => Number(meta.userData.height) || 0)) : Number(dimensions(image).height);
    const maxWidth = Number(atlas.userData.maxWidth), maxHeight = Number(atlas.userData.maxHeight);
    if (!width || !height || !maxWidth || !maxHeight) return true;
    return width <= maxWidth && height <= maxHeight || !!atlas.userData.allowRotation && height <= maxWidth && width <= maxHeight;
}

function planRecords(assets, options = {}) {
    const sourceType = options.sourceType || 'all';
    const atlases = assets.filter(asset => asset.meta.importer === 'auto-atlas');
    const images = assets.filter(asset => asset.meta.importer === 'image' && imageType(asset.url));
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
        const frames = Object.values(image.meta.subMetas || {}).filter(meta => meta.importer === 'sprite-frame');
        const sprite = image.meta.userData.type === 'sprite-frame' && frames.some(frame => frame.userData && frame.userData.packable !== false);
        if (!sprite) { owner = null; reason = '非可合图 Sprite，按独立图片配置'; }
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
    formatsFor, platformSummary, planRecords, dimensions, overrideGroup };
