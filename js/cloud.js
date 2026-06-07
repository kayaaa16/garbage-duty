/* ============================================================
   雲端存檔層（Supabase REST，免登入 / 免 SDK）
   - pull(): 取回雲端整包 state（或 null）
   - push(obj): debounce 後上傳整包 state
   對外：window.Cloud = { enabled, pull, push, flush }
   ============================================================ */
(function () {
  const cfg = window.GARBAGE_CONFIG || {};
  const enabled = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  const table = cfg.TABLE || 'garbage_duty_state';
  const rowId = cfg.ROW_ID || 'main';
  const base = enabled ? cfg.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/' + table : '';
  const headers = enabled ? {
    'apikey': cfg.SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + cfg.SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  } : {};

  async function pull() {
    if (!enabled) return null;
    const url = base + '?id=eq.' + encodeURIComponent(rowId) + '&select=data,updated_at';
    const res = await fetch(url, { headers, cache: 'no-store' });
    if (!res.ok) throw new Error('cloud pull ' + res.status);
    const rows = await res.json();
    return rows[0] || null; // { data, updated_at } | null
  }

  let timer = null, pending = null, inFlight = false;
  function push(dataObj) {
    if (!enabled) return;
    pending = dataObj;
    clearTimeout(timer);
    timer = setTimeout(flush, 1200);
  }
  async function flush() {
    if (!enabled || pending == null || inFlight) return;
    const payload = pending; pending = null; inFlight = true;
    try {
      // upsert：id 衝突就合併（更新）
      const res = await fetch(base + '?on_conflict=id', {
        method: 'POST',
        headers: Object.assign({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }, headers),
        body: JSON.stringify({ id: rowId, data: payload, updated_at: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error('cloud push ' + res.status);
      window.dispatchEvent(new CustomEvent('cloud:saved'));
    } catch (e) {
      console.warn('[cloud] push 失敗，資料仍在本機', e);
      window.dispatchEvent(new CustomEvent('cloud:error'));
    } finally {
      inFlight = false;
      if (pending != null) flush(); // 期間又有新變更
    }
  }

  window.Cloud = { enabled, pull, push, flush };
})();
