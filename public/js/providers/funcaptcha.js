/**
 * Arkose Labs FunCaptcha 前端加载器。
 *
 * 导出 mount(container, config, onSuccess, onError)
 * config 包含 publicKey。
 */
export function mount(container, config, onSuccess, onError) {
  const publicKey = config.publicKey;
  if (!publicKey) {
    onError && onError(new Error("FunCaptcha publicKey is missing"));
    return;
  }

  container.innerHTML = "";

  const div = document.createElement("div");
  div.id = "funcaptcha-" + Math.random().toString(36).slice(2, 8);
  container.appendChild(div);

  if (!window.funPk) {
    const script = document.createElement("script");
    script.src = "https://funcaptcha.com/fc/api.js";
    script.async = true;
    script.defer = true;
    script.onload = () => renderWidget(div.id, publicKey, onSuccess, onError);
    script.onerror = () => onError && onError(new Error("Failed to load FunCaptcha SDK"));
    document.head.appendChild(script);
  } else {
    renderWidget(div.id, publicKey, onSuccess, onError);
  }
}

function renderWidget(elementId, publicKey, onSuccess, onError) {
  try {
    setStatus(null);
    window.funPk = publicKey;
    // Arkose uses the funCaptcha global
    if (window.funCaptcha) {
      window.funCaptcha.reset();
    }
    const script = document.createElement("script");
    script.src = `https://funcaptcha.com/fc/api/?pk=${publicKey}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => onError && onError(new Error("Failed to load FunCaptcha widget"));

    // Arkose Labs callback: when solved, the form submits with fc-token
    window.onFunCaptchaSubmit = () => {
      const tokenEl = document.querySelector("[name='fc-token']");
      const token = tokenEl?.value ?? "";
      if (token) {
        onSuccess({ token });
      } else {
        onError && onError(new Error("FunCaptcha token not found"));
      }
    };
    document.head.appendChild(script);
  } catch (err) {
    onError && onError(err);
  }
}
