/**
 * 腾讯云 TCaptcha 前端加载器。
 *
 * 导出 mount(container, config, onSuccess, onError)
 * config 包含 appId (即 secret_id，腾讯 SDK 称为 appId)。
 */
export function mount(container, config, onSuccess, onError) {
  const appId = config.appId;
  if (!appId) {
    onError && onError(new Error("Tencent Captcha appId is missing"));
    return;
  }

  container.innerHTML = "";

  if (!window.TencentCaptcha) {
    const script = document.createElement("script");
    script.src = "https://turing.captcha.qcloud.com/TJCaptcha.js";
    script.async = true;
    script.onload = () => renderCaptcha(container, appId, onSuccess, onError);
    script.onerror = () => onError && onError(new Error("Failed to load Tencent Captcha SDK"));
    document.head.appendChild(script);
  } else {
    renderCaptcha(container, appId, onSuccess, onError);
  }
}

function renderCaptcha(container, appId, onSuccess, onError) {
  try {
    const el = document.createElement("div");
    el.id = "tencent-captcha-" + Math.random().toString(36).slice(2, 8);
    container.appendChild(el);

    const captcha = new window.TencentCaptcha(
      el.id,
      appId,
      (result) => {
        // result.ret === 0 表示成功
        if (result.ret === 0) {
          const randstr = result.randstr ?? "";
          const ticket = result.ticket ?? result.Ticket ?? "";
          onSuccess({
            token: ticket,
            extra: {
              randstr,
              captcha_app_id: String(appId),
            },
          });
        } else {
          onError && onError(new Error(`Tencent Captcha failed: ret=${result.ret}`));
        }
      },
      {
        needFeedBack: false,
      },
    );
    captcha.show();
  } catch (err) {
    onError && onError(err);
  }
}
