/**
 * Google reCAPTCHA 前端加载器。
 *
 * 导出 mount(container, config, onSuccess, onError)
 * config 包含 sitekey（由后端注入）。
 */
export function mount(container, config, onSuccess, onError) {
  const sitekey = config.siteKey;
  if (!sitekey) {
    onError && onError(new Error("reCAPTCHA siteKey is missing"));
    return;
  }

  // 清理旧容器
  container.innerHTML = "";

  // 加载 reCAPTCHA SDK
  if (!window.grecaptcha) {
    const script = document.createElement("script");
    script.src = "https://www.google.com/recaptcha/api.js";
    script.async = true;
    script.defer = true;
    script.onload = () => renderWidget(container, sitekey, onSuccess, onError);
    script.onerror = () => onError && onError(new Error("Failed to load reCAPTCHA SDK"));
    document.head.appendChild(script);
  } else {
    renderWidget(container, sitekey, onSuccess, onError);
  }
}

function renderWidget(container, sitekey, onSuccess, onError) {
  try {
    const widgetId = window.grecaptcha.render(container, {
      sitekey,
      callback: onSuccess,
      "expired-callback": () => onError && onError(new Error("reCAPTCHA expired")),
      "error-callback": () => onError && onError(new Error("reCAPTCHA error")),
    });
    container.dataset.recaptchaWidgetId = widgetId;
  } catch (err) {
    onError && onError(err);
  }
}
