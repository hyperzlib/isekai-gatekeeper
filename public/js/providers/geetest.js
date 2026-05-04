/**
 * GeeTest v4 前端加载器。
 *
 * 导出 mount(container, config, onSuccess, onError)
 * config 包含 gtId (captcha_id)。
 * 回调 onSuccess 接收 { token, extra: { lot_number, captcha_output, pass_token, gen_time } }
 */
export function mount(container, config, onSuccess, onError) {
  const captchaId = config.gtId;
  if (!captchaId) {
    onError && onError(new Error("GeeTest captchaId is missing"));
    return;
  }

  container.innerHTML = "";

  if (!window.initGeetest4) {
    const script = document.createElement("script");
    script.src = "https://static.geetest.com/v4/gt4.js";
    script.async = true;
    script.onload = () => initGeeTest(container, captchaId, onSuccess, onError);
    script.onerror = () => onError && onError(new Error("Failed to load GeeTest SDK"));
    document.head.appendChild(script);
  } else {
    initGeeTest(container, captchaId, onSuccess, onError);
  }
}

function initGeeTest(container, captchaId, onSuccess, onError) {
  try {
    window.initGeetest4(
      {
        captchaId,
        product: "bind",
      },
      (instance) => {
        instance.appendTo(container);
        instance.onReady(() => {
          instance.showCaptcha();
        });
        instance.onSuccess(() => {
          const result = instance.getValidate();
          if (!result) {
            onError && onError(new Error("GeeTest validation result is empty"));
            return;
          }
          // GeeTest v4: 后端需要所有验证参数
          onSuccess({
            token: result.captcha_output ?? result.captchaOutput ?? "",
            extra: {
              lot_number: result.lot_number ?? result.lotNumber ?? "",
              captcha_output: result.captcha_output ?? result.captchaOutput ?? "",
              pass_token: result.pass_token ?? result.passToken ?? "",
              gen_time: result.gen_time ?? result.genTime ?? "",
            },
          });
        });
        instance.onError((err) => {
          onError && onError(new Error(`GeeTest error: ${err?.msg ?? err}`));
        });
      },
    );
  } catch (err) {
    onError && onError(err);
  }
}
