'use strict';

function checkCancelled(signal) {
    if (signal && signal.aborted) {
        const error = new Error('检索已停止。');
        error.code = 'ASTC_CANCELLED';
        throw error;
    }
}

// 限制 IPC 并发；同步回调密集返回时也定期让出渲染线程。
async function forEachLimit(items, limit, work, signal) {
    let cursor = 0, failed = false;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        let yieldedAt = Date.now(), processed = 0;
        try {
            while (!failed && cursor < items.length) {
                checkCancelled(signal);
                const index = cursor++;
                await work(items[index], index);
                checkCancelled(signal);
                if (++processed % 32 === 0 && Date.now() - yieldedAt >= 8) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                    yieldedAt = Date.now();
                }
            }
        } catch (error) { failed = true; throw error; }
    }));
    checkCancelled(signal);
}

module.exports = { forEachLimit, checkCancelled };
