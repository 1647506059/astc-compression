'use strict';

const fs = require('fs');
const { createService } = require('../lib/asset-service');
const config = require('../lib/texture-config');
const { forEachLimit, checkCancelled } = require('../lib/async-work');

function createPanel(root, editor) {
    const service = createService(editor.assetdb);
    const el = id => root.querySelector('#' + id);
    const state = { roots: [], rows: [], page: 0, busy: false, phase: '', scanned: false, disposed: false, signal: null };
    const pageSize = 100;
    let filtered = [], filterTimer, progressAt = 0, progressStage = '';
    const key = 'astc-directories:' + editor.Project.path;
    let recent = [];
    try {
        const saved = JSON.parse(window.localStorage.getItem(key) || '[]');
        if (Array.isArray(saved)) recent = saved.filter(url => typeof url === 'string').slice(0, 6);
    } catch (_) { /* 无本机历史 */ }
    const selectedPlatforms = () => [...root.querySelectorAll('[data-platform]:checked')].map(input => input.dataset.platform);
    const options = () => ({ sourceType: el('source-type').value, block: el('block').value,
        quality: el('quality').value, fallbackQuality: el('fallback-quality').value });
    const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    const configured = (row, platforms) => platforms.some(id => Object.prototype.hasOwnProperty.call(row.meta.platformSettings || {}, id));
    function notice(text, error = false) {
        if (state.disposed) return;
        el('notice').textContent = text;
        el('notice').classList.toggle('error', error);
    }
    function busy(value, phase = '') {
        state.busy = value; state.phase = value ? phase : '';
        if (state.disposed) return;
        root.querySelectorAll('button,input,select').forEach(input => { input.disabled = value; });
        el('cancel').hidden = !value || phase !== 'scan';
        el('cancel').disabled = !value || phase !== 'scan';
        if (!value) renderRows();
    }
    function progress(info) {
        if (state.disposed) return;
        const stage = info.stage || (info.phase === 'scan' ? '检索' : info.phase === 'apply' ? '配置' : '移除');
        const now = Date.now();
        if (stage === progressStage && info.done !== info.total && now - progressAt < 50) return;
        progressAt = now; progressStage = stage;
        el('progress').value = info.total ? info.done / info.total : 0;
        el('progress-label').textContent = stage + ' ' + info.done + ' / ' + info.total;
    }
    function toUrl(value) {
        const text = String(value || '').trim();
        if (!text) throw new Error('请填写目录路径。');
        if (text.startsWith('db://')) return config.normalizeUrl(text);
        if (/^assets(?:[/\\]|$)/.test(text)) return config.normalizeUrl('db://' + text.replace(/\\/g, '/'));
        const url = editor.assetdb.remote.fspathToUrl(text);
        return config.normalizeUrl(url);
    }
    function invalidate() {
        state.rows = []; state.scanned = false; state.page = 0;
        el('progress').value = 0; el('progress-label').textContent = '待检索';
        renderRoots(); renderRows();
    }
    function renderRoots() {
        if (state.disposed) return;
        el('roots').innerHTML = state.roots.length ? state.roots.slice(0, 12).map((url, index) =>
            '<span class="path-chip" title="' + escape(url) + '"><span>' + escape(url.replace('db://assets', 'assets')) + '</span><button data-remove-root="' + index + '" title="移除检索路径">×</button></span>').join('') : '<span class="muted">选择资源目录，或直接输入路径。</span>';
        if (state.roots.length > 12) el('roots').insertAdjacentHTML('afterbegin', '<span class="root-count muted">共 ' + state.roots.length + ' 条路径，展示前 12 条</span>');
        el('recent').innerHTML = recent.length ? '<span class="muted">最近：</span>' + recent.map((url, index) =>
            '<button class="link" data-recent="' + index + '" title="' + escape(url) + '">' + escape(url.split('/').slice(-2).join('/')) + '</button>').join('') : '';
    }
    function updateSelection(platforms = selectedPlatforms()) {
        let atlas = 0, png = 0, jpg = 0, covered = 0, own = 0, checked = 0, applicable = 0, removable = 0;
        for (const row of state.rows) {
            const hasConfig = configured(row, platforms);
            if (hasConfig) own++;
            if (row.ownerUuid) covered++;
            if (row.eligible) {
                if (row.kind === 'atlas') atlas++;
                else if (row.kind === 'png') png++;
                else if (row.kind === 'jpg') jpg++;
            }
            if (row.checked) {
                checked++;
                if (row.eligible) applicable++;
                if (hasConfig) removable++;
            }
        }
        el('atlas-count').textContent = atlas; el('png-count').textContent = png;
        el('jpg-count').textContent = jpg; el('covered-count').textContent = covered;
        el('configured-count').textContent = own;
        el('selection-summary').textContent = '勾选 ' + checked + ' 项 · 可配置 ' + applicable + ' 项 · 可移除 ' + removable + ' 项';
        el('apply').disabled = state.busy || !state.scanned || !platforms.length || !applicable;
        el('remove').disabled = state.busy || !state.scanned || !platforms.length || !removable;
        el('remove-directory').disabled = state.busy || !state.scanned || !platforms.length || !own;
        let available = 0, selected = 0;
        for (const entry of filtered) if (!entry.row.conflict) { available++; if (entry.row.checked) selected++; }
        el('select-all').checked = available > 0 && selected === available;
        el('select-all').indeterminate = selected > 0 && selected < available;
        el('select-all').disabled = state.busy || !available;
    }
    function renderRows() {
        if (state.disposed) return;
        const platforms = selectedPlatforms();
        const keyword = el('keyword').value.trim().toLowerCase();
        const showCovered = el('show-covered').checked, onlyConfigured = el('configured-only').checked;
        filtered = [];
        state.rows.forEach((row, index) => {
            if ((!row.ownerUuid || showCovered) && (!onlyConfigured || configured(row, platforms)) &&
                (!keyword || row.url.toLowerCase().includes(keyword))) filtered.push({row, index});
        });
        const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
        state.page = Math.min(state.page, pages - 1);
        const start = state.page * pageSize, end = Math.min(start + pageSize, filtered.length);
        el('results').innerHTML = filtered.slice(start, end).map(({row, index}) => {
            const summaries = config.platformSummary(row.meta, platforms);
            const width = row.kind === 'atlas' ? row.meta.maxWidth : row.meta.width;
            const height = row.kind === 'atlas' ? row.meta.maxHeight : row.meta.height;
            const size = width && height ? (row.kind === 'atlas' ? '上限 ' : '') + width + ' × ' + height : '—';
            const tag = row.kind === 'atlas' ? '图集' : row.kind.toUpperCase();
            return '<tr class="' + (row.ownerUuid ? 'covered' : '') + '"><td><input type="checkbox" data-row="' + index + '" ' +
                (row.checked ? 'checked ' : '') + (row.conflict ? 'disabled' : '') + '></td><td><span class="kind ' + row.kind + '">' + tag + '</span></td>' +
                '<td class="resource"><button class="resource-name" data-reveal="' + index + '" title="在资源管理器定位">' + escape(row.url.split('/').pop()) + '</button>' +
                '<span class="resource-path" title="' + escape(row.url) + '">' + escape(row.url.replace('db://assets/', '')) + '</span>' +
                '<span class="reason ' + (row.conflict ? 'warning' : '') + '">' + escape(row.reason) + (row.kind === 'atlas' && row.members ? ' · ' + row.members + ' 张匹配碎图' : '') + '</span></td>' +
                '<td class="size">' + size + '</td><td class="current">' + (summaries.length ? summaries.map(summary => '<div><span class="platform-name">' +
                    escape(config.PLATFORMS.find(item => item.id === summary.platform).label) + '</span>' + escape(summary.text) + '</div>').join('') : '<span class="muted">未选择平台</span>') + '</td></tr>';
        }).join('');
        el('result-count').textContent = filtered.length > pageSize ? '显示 ' + (start + 1) + '–' + end + ' / ' + filtered.length : '显示 ' + filtered.length + ' / ' + state.rows.length;
        el('pagination').hidden = filtered.length <= pageSize;
        el('page-label').textContent = (state.page + 1) + ' / ' + pages + ' 页 · 每页 ' + pageSize + ' 项';
        el('previous-page').disabled = state.busy || state.page === 0;
        el('next-page').disabled = state.busy || state.page >= pages - 1;
        el('empty').hidden = filtered.length > 0;
        el('empty').textContent = !state.scanned ? '先检索，查看将配置的图集和碎图。' : '当前条件下没有资源。';
        updateSelection(platforms); preview();
    }
    function preview() {
        try {
            const opts = options();
            const image = config.formatsFor({ kind: 'jpg' }, opts).map(item => item.name).join(' + ');
            const atlas = config.formatsFor({ kind: 'atlas' }, opts).map(item => item.name).join(' + ');
            el('format-preview').textContent = '图集 / PNG：' + atlas + '　　JPG：' + image;
        } catch (error) { el('format-preview').textContent = error.message; }
    }
    async function scan(loadRoots) {
        if (state.busy) return;
        const signal = {aborted: false}; state.signal = signal;
        state.scanned = false; state.rows = []; state.page = 0;
        progressAt = 0; progressStage = '';
        busy(true, 'scan'); renderRows(); notice('正在读取资源与当前压缩配置…');
        try {
            const report = info => { if (state.signal === signal && !signal.aborted) progress(info); };
            const roots = typeof loadRoots === 'function' ? await loadRoots(signal, report) : state.roots;
            checkCancelled(signal);
            const result = await service.scan(roots, options(), report, signal);
            if (state.disposed) return;
            state.roots = result.roots;
            state.rows = result.rows.map(row => Object.assign(row, { checked: row.eligible }));
            state.scanned = true;
            recent = [...new Set(state.roots.concat(recent))].slice(0, 6);
            try { window.localStorage.setItem(key, JSON.stringify(recent)); } catch (_) { /* 不影响检索 */ }
            notice(result.stats.conflicts ? '检索完成；发现 ' + result.stats.conflicts + ' 项图集归属冲突，请先整理。' : '检索完成。图集内碎图不重复配置；可显示它们并单独移除旧配置。');
        } catch (error) { state.rows = []; notice(error.message, error.code !== 'ASTC_CANCELLED'); }
        finally { state.signal = null; busy(false); renderRoots(); }
    }
    async function execute(action, directory = false) {
        if (state.busy || !state.scanned) return;
        const rows = directory ? state.rows : state.rows.filter(row => row.checked);
        busy(true, 'write');
        try {
            const result = await service.write(rows, selectedPlatforms(), options(), action, progress);
            const report = (action === 'apply' ? '配置' : '移除') + '完成：成功 ' + result.changed + '，未改变 ' + result.unchanged + '，失败 ' + result.failed.length;
            await refreshAfterWrite();
            notice(report + (result.failed.length ? '\n' + result.failed.map(item => item.url + '：' + item.message).join('\n') : ''), result.failed.length > 0);
        } catch (error) { notice(error.message, true); }
        finally { busy(false); }
    }
    async function refreshAfterWrite() {
        const checked = new Set(state.rows.filter(row => row.checked).map(row => row.uuid));
        try {
            const result = await service.scan(state.roots, options());
            state.rows = result.rows.map(row => Object.assign(row, { checked: checked.has(row.uuid) }));
            state.scanned = true;
        } catch (error) { state.rows = []; state.scanned = false; state.page = 0; throw new Error('操作已结束，但复查失败，请重新检索：' + error.message); }
    }
    async function useSelection() {
        if (state.busy) return;
        try {
            const uuids = editor.Selection.curSelection('asset');
            if (!uuids || !uuids.length) throw new Error('请先在资源管理器选中目录、图集或图片。');
            await scan(async (signal, report) => {
                const selection = new Array(uuids.length);
                let completed = 0;
                await forEachLimit(uuids, 8, async (uuid, index) => {
                    const url = await new Promise((resolve, reject) => {
                        editor.assetdb.queryUrlByUuid(uuid, (error, url) => {
                            if (error) { reject(error); return; }
                            try { resolve(toUrl(url)); } catch (err) { reject(err); }
                        });
                    });
                    selection[index] = {uuid, url};
                    report({phase:'scan',stage:'读取选择',done:++completed,total:uuids.length});
                }, signal);
                return selection;
            });
        } catch (error) { notice(error.message, true); }
    }
    el('platforms').innerHTML = config.PLATFORMS.map(item => '<label><input type="checkbox" data-platform="' + item.id + '" ' + (item.id === 'minigame' ? 'checked' : '') + '>' + item.label + '</label>').join('');
    el('use-selection').addEventListener('click', useSelection);
    el('choose-folder').addEventListener('click', async () => {
        try {
            const result = await editor.Dialog.openFile({ title: '选择 ASTC 检索目录', defaultPath: editor.Project.path + '/assets', properties: ['openDirectory', 'multiSelections'] });
            const paths = Array.isArray(result) ? result : result && result.filePaths || [];
            if (!paths.length) return;
            state.roots = paths.map(toUrl); invalidate(); await scan();
        } catch (error) { notice(error.message, true); }
    });
    function addPath() {
        try { state.roots = [...new Set(state.roots.concat(toUrl(el('path-input').value)))]; el('path-input').value = ''; invalidate(); scan(); }
        catch (error) { notice(error.message, true); }
    }
    el('add-path').addEventListener('click', addPath);
    el('path-input').addEventListener('keydown', event => { if (event.key === 'Enter') addPath(); });
    el('scan').addEventListener('click', () => scan());
    el('cancel').addEventListener('click', () => { if (state.signal) { state.signal.aborted = true; notice('正在停止检索…'); } });
    el('clear-paths').addEventListener('click', () => { state.roots = []; invalidate(); notice('已清空路径。'); });
    el('roots').addEventListener('click', event => { const button = event.target.closest('[data-remove-root]'); if (button && !state.busy) { state.roots.splice(Number(button.dataset.removeRoot), 1); invalidate(); } });
    el('recent').addEventListener('click', event => { const button = event.target.closest('[data-recent]'); if (button && !state.busy) { state.roots = [recent[Number(button.dataset.recent)]]; invalidate(); scan(); } });
    el('platforms').addEventListener('change', () => { state.page = 0; renderRows(); });
    el('source-type').addEventListener('change', () => { invalidate(); notice('图片筛选已改变，请重新检索。'); });
    for (const id of ['block', 'quality', 'fallback-quality']) el(id).addEventListener('change', preview);
    el('keyword').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => { state.page = 0; renderRows(); }, 100); });
    for (const id of ['configured-only', 'show-covered']) el(id).addEventListener('change', () => { state.page = 0; renderRows(); });
    el('previous-page').addEventListener('click', () => { if (state.page > 0) { state.page--; renderRows(); } });
    el('next-page').addEventListener('click', () => { state.page++; renderRows(); });
    el('select-all').addEventListener('change', event => {
        for (const entry of filtered) if (!entry.row.conflict) entry.row.checked = event.target.checked;
        root.querySelectorAll('[data-row]').forEach(input => { input.checked = state.rows[Number(input.dataset.row)].checked; });
        updateSelection();
    });
    el('results').addEventListener('change', event => { if (event.target.dataset.row != null) { state.rows[Number(event.target.dataset.row)].checked = event.target.checked; updateSelection(); } });
    el('results').addEventListener('click', event => { const button = event.target.closest('[data-reveal]'); if (button) editor.Selection.select('asset', state.rows[Number(button.dataset.reveal)].uuid); });
    el('apply').addEventListener('click', () => execute('apply'));
    el('remove').addEventListener('click', () => execute('remove'));
    el('remove-directory').addEventListener('click', () => execute('remove', true));
    renderRoots(); renderRows();
    return { state, scan, execute, dispose() { state.disposed = true; if (state.signal) state.signal.aborted = true; clearTimeout(filterTimer); } };
}

if (typeof Editor !== 'undefined') {
    Editor.Panel.extend({
        style: fs.readFileSync(Editor.url('packages://astc/panel/index.css'), 'utf8'),
        template: fs.readFileSync(Editor.url('packages://astc/panel/index.html'), 'utf8'),
        ready() { this.astcPanel = createPanel(this.shadowRoot, Editor); },
        close() { if (this.astcPanel) this.astcPanel.dispose(); },
    });
} else module.exports = { createPanel };
