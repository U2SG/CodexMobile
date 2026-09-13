// Shown when the server reports a newer client build than the one this page
// is running. Reuses the connection-recovery-card shell so the two banners
// share one visual language (they never render together — recovery wins).
export function UpdateBanner({ onReload }) {
  return (
    <section className="connection-recovery-card is-update" aria-label="版本更新">
      <span className="connection-recovery-dot" />
      <span className="connection-recovery-main">
        <strong>发现新版本</strong>
        <small>刷新页面以加载最新构建</small>
      </span>
      <button type="button" onClick={onReload}>
        刷新
      </button>
    </section>
  );
}
