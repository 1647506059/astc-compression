'use strict';

const { createHash } = require('crypto');
const { formatsFor, overrideGroup } = require('./texture-config');

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function signature(preset) {
    return JSON.stringify(stable({ options: preset && preset.options || {}, overwrite: preset && preset.overwrite || {} }));
}

function resolvePreset(meta, presets, strict = false) {
    const settings = meta.userData && meta.userData.compressSettings;
    if (!settings || !settings.useCompressTexture) return null;
    const preset = presets[settings.presetId];
    if (!preset && strict) throw new Error('压缩预设已失效，请先修复预设后重新检索：' + (settings.presetId || '未指定'));
    return preset || null;
}

function changePreset(base, row, platforms, options, action) {
    const preset = JSON.parse(JSON.stringify(base || { options: {} }));
    preset.options = preset.options || {};
    const formats = action === 'apply' ? Object.fromEntries(formatsFor(row, options).map(({ name, quality }) => [name, { quality }])) : null;
    for (const platform of platforms) {
        if (formats) preset.options[platform] = formats;
        else delete preset.options[platform];
    }
    // 既有平台覆盖也属于所选分组，避免它们遮住刚应用的分组配置。
    for (const platform of Object.keys(preset.overwrite || {})) {
        if (!platforms.includes(overrideGroup(platform))) continue;
        if (formats) preset.overwrite[platform] = formats;
        else delete preset.overwrite[platform];
    }
    return preset;
}

function hasFormats(preset) {
    return [preset.options, preset.overwrite].some(group => Object.values(group || {}).some(formats => Object.keys(formats || {}).length));
}

async function ensurePreset(editor, preset) {
    const users = await editor.Profile.getProject('builder', 'textureCompressConfig.userPreset') || {};
    const defaults = await editor.Profile.getProject('builder', 'textureCompressConfig.defaultConfig') || {};
    const value = signature(preset);
    const all = { ...defaults, ...users };
    const existing = Object.entries(all).find(([, item]) => item && signature(item) === value);
    if (existing) return existing[0];
    const stem = 'astc-' + createHash('sha256').update(value).digest('hex').slice(0, 24);
    let id = stem, index = 1;
    while (all[id]) id = stem + '-' + index++;
    // 只新增一个预设，不覆盖共享预设或其他项目设置。
    await editor.Profile.setProject('builder', 'textureCompressConfig.userPreset.' + id,
        { ...preset, name: 'ASTC 批量配置 · ' + id.slice(5, 13) });
    return id;
}

module.exports = { signature, resolvePreset, changePreset, hasFormats, ensurePreset };
