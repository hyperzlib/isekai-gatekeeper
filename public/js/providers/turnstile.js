/**
 * Cloudflare Turnstile 前端加载器。
 *
 * 导出 mount(container, config, onSuccess, onError)
 * config 包含 siteKey。
 */
export function mount(container, config, onSuccess, onError) {
  const sitekey = config.siteKey;
  if (!sitekey) {
    onError && onError(new Error("Turnstile siteKey is missing"));
    return;
  }

  container.innerHTML = "";

  const widgetId = "turnstile-widget-" + Math.random().toString(36).slice(2, 8);
  container.id = widgetId;

  if (!window.turnstile) {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;
    script.onload = () => renderWidget(widgetId, sitekey, onSuccess, onError);
    script.onerror = () => onError && onError(new Error("Failed to load Turnstile SDK"));
    document.head.appendChild(script);
  } else {
    renderWidget(widgetId, sitekey, onSuccess, onError);
  }
}

function renderWidget(widgetId, sitekey, onSuccess, onError) {
  try {
    window.turnstile.render("#" + widgetId, {
      sitekey,
      callback: onSuccess,
      "expired-callback": () => onError && onError(new Error("Turnstile expired")),
      "error-callback": () => onError && onError(new Error("Turnstile error")),
    });
  } catch (err) {
    onError && onError(err);
  }
}
