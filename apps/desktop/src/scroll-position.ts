export function captureMainScroll() {
  const main = document.querySelector<HTMLElement>("main.primary-main");
  const top = main?.scrollTop ?? 0;
  return () => {
    if (!main?.isConnected) return;
    requestAnimationFrame(() => {
      main.scrollTop = Math.min(top, Math.max(0, main.scrollHeight - main.clientHeight));
    });
  };
}
