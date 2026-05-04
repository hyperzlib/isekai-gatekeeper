/**
 * hCaptcha 前端加载器。
 *
 * 导出 mount(container, config, onSuccess, onError)
 * config 包含 sitekey（由后端注入）。
 */
export function mount(container, config, onSuccess, onError) {
  const sitekey = config.siteKey;
  if (!sitekey) {
    onError && onError(new Error("hCaptcha siteKey is missing"));
    return;
  }

  container.innerHTML = "";

  if (!window.hcaptcha) {
    const script = document.createElement("script");
    script.src = "https://js.hcaptcha.com/1/api.js";
    script.async = true;
    script.defer = true;
    script.onload = () => renderWidget(container, sitekey, onSuccess, onError);
    script.onerror = () => onError && onError(new Error("Failed to load hCaptcha SDK"));
    document.head.appendChild(script);
  } else {
    renderWidget(container, sitekey, onSuccess, onError);
  }
}

function renderWidget(container, sitekey, onSuccess, onError) {
  try {
    window.hcaptcha.render(container, {
      sitekey,
      callback: onSuccess,
      "expired-callback": () => onError && onError(new Error("hCaptcha expired")),
      "error-callback": () => onError && onError(new Error("hCaptcha error")),
    });
  } catch (err) {
    onError && onError(err);
  }
}
