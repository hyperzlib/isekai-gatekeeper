/**
 * 阿里云 Captcha2 前端加载器。
 *
 * 导出 mount(container, config, onSuccess, onError)
 * config 包含 sceneId (可选，默认 "default")。
 *
 * 阿里云验证码使用 window.AWSC 和 new AliCaptcha，配置 accessKey 由后端注入。
 */
export function mount(container, config, onSuccess, onError) {
  const sceneId = config.sceneId || "default";

  container.innerHTML = "";

  // 阿里云 Captcha2 SDK
  if (!window.AliCaptcha) {
    const script = document.createElement("script");
    script.src = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
    script.async = true;
    script.onload = () => renderCaptcha(container, sceneId, onSuccess, onError);
    script.onerror = () => onError && onError(new Error("Failed to load Aliyun Captcha SDK"));
    document.head.appendChild(script);
  } else {
    renderCaptcha(container, sceneId, onSuccess, onError);
  }
}

function renderCaptcha(container, sceneId, onSuccess, onError) {
  try {
    const el = document.createElement("div");
    el.id = "aliyun-captcha-" + Math.random().toString(36).slice(2, 8);
    container.appendChild(el);

    const captcha = new window.AliCaptcha({
      id: el.id,
      scene: sceneId,
      prefix: "aliyun_",
      language: "zh",
      success: (result) => {
        // result 包含 captchaVerifyParam 供后端校验
        onSuccess({
          token: result.captchaVerifyParam ?? "",
        });
      },
      fail: (err) => {
        onError && onError(new Error(`Aliyun Captcha failed: ${err}`));
      },
    });
    captcha.show();
    setStatus(null);
  } catch (err) {
    onError && onError(err);
  }
}
