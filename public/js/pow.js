/**
 * pow.js — WebGL2 hashcash 求解器 + 验证码插件加载器
 *
 * 流程：
 * 1. 从 data 属性读取配置（含 captchaProvider / captchaSiteKey / captchaGtId）
 * 2. GET challenge API → {challenge, expires, token, difficulty}
 * 3. 检测 WebGL2 软件渲染器 → 回退到验证码
 * 4. WebGL2 片段着色器 SHA-256 并行求解（1M nonce/帧）
 * 5. 求解成功 → POST verify → redirect
 * 6. 超时（30s）或 WebGL2 不可用 → 动态加载验证码 provider
 */

const CONFIG_EL = document.getElementById("challenge-config");
const CONFIG = CONFIG_EL ? JSON.parse(CONFIG_EL.textContent) : {};
const CHALLENGE_API = CONFIG.challengeApi ?? "/.isekai-gatekeeper/challenge";
const VERIFY_API = CONFIG.verifyApi ?? "/.isekai-gatekeeper/verify";
const CAPTCHA_PROVIDER = CONFIG.captchaProvider ?? "";
const REDIRECT_URL = CONFIG.redirect ?? ".";
const TIMEOUT_MS = 30_000;
const BATCH_SIZE = 1024; // 1024×1024 = 1M nonce/帧

const challengeTipsEl = document.getElementById("challenge-tips");
const statusEl = document.getElementById("status");
const captchaContainer = document.getElementById("captcha-container");
const spinnerEl = document.getElementById("spinner");

function setChallengeTips(msg) {
  if (challengeTipsEl) {
    if (msg) {
      challengeTipsEl.textContent = msg;
      challengeTipsEl.style.display = "block";
    } else {
      challengeTipsEl.style.display = "none";
    }
  }
}

function setStatus(msg) {
  if (statusEl) {
    if (msg) {
      statusEl.textContent = msg;
      statusEl.style.display = "block";
    } else {
      statusEl.style.display = "none";
    }
  }
}

/**
 * 显示验证码容器并动态加载对应 provider 脚本。
 */
async function showCaptcha() {
  if (!CAPTCHA_PROVIDER) {
    setStatus("验证码服务未配置，请刷新重试。");
    return;
  }

  if (spinnerEl) spinnerEl.style.display = "none";
  if (captchaContainer) captchaContainer.style.display = "block";
  setChallengeTips("自动验证失败，请完成验证码验证。");
  setStatus("正在加载验证码");

  const modulePath = `/.isekai-gatekeeper/public/js/providers/${CAPTCHA_PROVIDER}.js`;

  try {
    const mod = await import(modulePath);
    if (typeof mod.mount !== "function") {
      throw new Error(`Provider "${CAPTCHA_PROVIDER}" missing mount function`);
    }

    console.log(captchaContainer);
    mod.mount(
      captchaContainer,
      CONFIG,
      // onSuccess — 接受 token（字符串）或 { token, extra } 对象
      async (result) => {
        const payload = normalizeCaptchaPayload(result);
        await submitCaptcha(payload);
      },
      // onError
      (err) => {
        setStatus(`验证码加载失败：${err?.message ?? err}，请刷新重试。`);
        console.error("Captcha error:", err);
      },
    );
  } catch (err) {
    setStatus(`验证码加载失败：${err?.message ?? err}，请刷新重试。`);
    console.error("Captcha load error:", err);
  }
}

function redirectAfterSuccess() {
  location.href = REDIRECT_URL;
}

/**
 * 统一验证码回调格式 → { token: string, extra?: Record<string, string> }
 */
function normalizeCaptchaPayload(result) {
  if (typeof result === "string") {
    return { token: result, extra: {} };
  }
  return {
    token: result?.token ?? "",
    extra: result?.extra ?? {},
  };
}

/**
 * 提交验证码 token 到后端 verify 接口。
 */
async function submitCaptcha({ token, extra }) {
  setStatus("正在提交验证码…");
  try {
    const res = await fetch(VERIFY_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "captcha",
        captcha_token: token,
        extra,
      }),
    });
    if (res.ok) {
      redirectAfterSuccess();
    } else {
      const data = await res.json().catch(() => ({}));
      setStatus(`验证失败：${data.error ?? "未知错误"}，请刷新重试。`);
    }
  } catch {
    setStatus("网络错误，请刷新重试。");
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

async function main() {
  setStatus("正在获取自动验证信息…");
  let challenge, expires, token, difficulty;
  try {
    const res = await fetch(CHALLENGE_API);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ({ challenge, expires, token, difficulty } = await res.json());
  } catch (e) {
    setStatus(`获取自动验证信息失败：${e.message}`);
    showCaptcha();
    return;
  }

  setStatus("正在初始化自动验证…");

  // 检测 WebGL2
  const canvas = document.getElementById("c");
  const gl = canvas?.getContext("webgl2");
  if (!gl) {
    showCaptcha();
    return;
  }

  // 检测软件渲染器
  const dbgInfo = gl.getExtension("WEBGL_debug_renderer_info");
  if (dbgInfo) {
    const renderer = gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL) ?? "";
    if (/SwiftShader|llvmpipe|softpipe/i.test(renderer)) {
      showCaptcha();
      return;
    }
  }

  setStatus("正在进行自动验证…");

  try {
    const nonce = await solveWebGL2(gl, challenge, difficulty);
    setStatus("验证成功，正在跳转…");
    const res = await fetch(VERIFY_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "pow",
        challenge,
        nonce,
        token,
        expires
      }),
    });
    if (res.ok) {
      redirectAfterSuccess();
    } else {
      const data = await res.json().catch(() => ({}));
      setStatus(`自动验证失败：${data.error ?? "未知错误"}`);
    }
  } catch (e) {
    if (e.message === "TIMEOUT") {
      showCaptcha();
    } else {
      setStatus(`自动验证失败：${e.message}`);
      showCaptcha();
    }
  }
}

// ── WebGL2 SHA-256 求解器 ────────────────────────────────────────────────────

/**
 * 将 16 字节 hex challenge 转换为 8 个 uint32（大端序）供 GLSL 使用。
 */
function challengeToU32Array(hexStr) {
  const out = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = parseInt(hexStr.slice(i * 8, i * 8 + 8), 16);
  }
  return out;
}

const VERT_SRC = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// SHA-256 GLSL 实现（标准常量 + 消息扩展 + 压缩循环）
const FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform uint uOffset;
uniform uvec4 uChallenge0; // challenge words 0-3
uniform uvec4 uChallenge1; // challenge words 4-7
uniform uint  uDifficulty;

out vec4 fragColor;

// ── SHA-256 constants ────────────────────────────────────────────────────────
const uint K[64] = uint[64](
  0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
  0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
  0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
  0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
  0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
  0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
  0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
  0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
  0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
  0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
  0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
  0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
  0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
  0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
  0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
  0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
);

uint rotr(uint x, uint n) { return (x >> n) | (x << (32u - n)); }
uint ch(uint e, uint f, uint g) { return (e & f) ^ (~e & g); }
uint maj(uint a, uint b, uint c) { return (a & b) ^ (a & c) ^ (b & c); }
uint ep0(uint a) { return rotr(a,2u)^rotr(a,13u)^rotr(a,22u); }
uint ep1(uint e) { return rotr(e,6u)^rotr(e,11u)^rotr(e,25u); }
uint sig0(uint x) { return rotr(x,7u)^rotr(x,18u)^(x>>3u); }
uint sig1(uint x) { return rotr(x,17u)^rotr(x,19u)^(x>>10u); }

// SHA-256 of (challenge[16B] || nonce[4B BE]) = 20 bytes
// Padded message: 20 bytes data + padding to 64-byte block
uvec4 sha256_20(uint c0,uint c1,uint c2,uint c3, uint nonce) {
  // message words (big-endian)
  uint w[64];
  w[0]  = c0;
  w[1]  = c1;
  w[2]  = c2;
  w[3]  = c3;
  w[4]  = uChallenge1.x;
  w[5]  = uChallenge1.y;
  w[6]  = uChallenge1.z;
  w[7]  = uChallenge1.w;
  // nonce (4 bytes big-endian) then padding bit
  w[8]  = nonce;           // nonce as 4-byte BE uint
  // 0x80 padding then zeros then length
  // after 20 bytes: byte 20 = 0x80
  // 20 bytes = 160 bits = 0x000000A0
  w[9]  = 0x00000000u;
  w[10] = 0x00000000u;
  w[11] = 0x00000000u;
  w[12] = 0x00000000u;
  w[13] = 0x00000000u;
  w[14] = 0x00000000u;
  w[15] = 0x000000A0u; // length: 20*8 = 160 bits

  // We need to embed the 0x80 into the right word.
  // 20 bytes: bytes 0-19 are data; byte 20 (0-indexed) is 0x80
  // byte 20 is in word 5 (20/4 = 5), bit position (20%4)*8 = 0, so high byte
  // But above we have w[4]=challenge[16..19]=uChallenge1.x and
  // w[8]=nonce (bytes 16-19). Wait, let me recount:
  // challenge is 16 bytes = words 0-3 (w[0]..w[3])
  // nonce is 4 bytes = word 4 (w[4])
  // So byte 20 = word 5, high byte → w[5] |= 0x80000000u
  // Fix:
  w[4]  = nonce;
  w[5]  = 0x80000000u;
  w[6]  = 0x00000000u;
  w[7]  = 0x00000000u;
  w[8]  = 0x00000000u;
  w[9]  = 0x00000000u;
  w[10] = 0x00000000u;
  w[11] = 0x00000000u;
  w[12] = 0x00000000u;
  w[13] = 0x00000000u;
  w[14] = 0x00000000u;
  w[15] = 0x000000A0u;

  // Overwrite w[0..3] from challenge words 0-3
  w[0] = c0; w[1] = c1; w[2] = c2; w[3] = c3;

  // Message schedule
  for (int i = 16; i < 64; i++) {
    w[i] = sig1(w[i-2]) + w[i-7] + sig0(w[i-15]) + w[i-16];
  }

  // Initial hash values
  uint h0 = 0x6a09e667u, h1 = 0xbb67ae85u, h2 = 0x3c6ef372u, h3 = 0xa54ff53au;
  uint h4 = 0x510e527fu, h5 = 0x9b05688cu, h6 = 0x1f83d9abu, h7 = 0x5be0cd19u;

  uint a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
  for (int i = 0; i < 64; i++) {
    uint t1 = h + ep1(e) + ch(e,f,g) + K[i] + w[i];
    uint t2 = ep0(a) + maj(a,b,c);
    h=g; g=f; f=e; e=d+t1;
    d=c; c=b; b=a; a=t1+t2;
  }
  return uvec4(h0+a, h1+b, h2+c, h3+d);
}

bool checkDifficulty(uvec4 firstWords, uint difficulty) {
  uint fullWords = difficulty / 32u;
  uint remBits   = difficulty % 32u;
  if (fullWords > 0u && firstWords.x != 0u) return false;
  if (fullWords > 1u && firstWords.y != 0u) return false;
  if (fullWords > 2u && firstWords.z != 0u) return false;
  if (fullWords > 3u && firstWords.w != 0u) return false;
  if (remBits > 0u) {
    uint word;
    if      (fullWords == 0u) word = firstWords.x;
    else if (fullWords == 1u) word = firstWords.y;
    else if (fullWords == 2u) word = firstWords.z;
    else                      word = firstWords.w;
    uint mask = ~((1u << (32u - remBits)) - 1u);
    if ((word & mask) != 0u) return false;
  }
  return true;
}

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  uint localIdx = uint(coord.y * ${BATCH_SIZE} + coord.x);
  uint nonce = uOffset + localIdx;

  uvec4 first4 = sha256_20(uChallenge0.x, uChallenge0.y, uChallenge0.z, uChallenge0.w, nonce);

  if (checkDifficulty(first4, uDifficulty)) {
    // Encode nonce into RGBA (8-bit per channel, big-endian)
    fragColor = vec4(
      float((nonce >> 24u) & 0xFFu) / 255.0,
      float((nonce >> 16u) & 0xFFu) / 255.0,
      float((nonce >>  8u) & 0xFFu) / 255.0,
      float( nonce         & 0xFFu) / 255.0
    );
  } else {
    fragColor = vec4(0.0);
  }
}
`.replace(/\$\{BATCH_SIZE\}/g, String(BATCH_SIZE));

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("Shader error: " + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function createProgram(gl) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, VERT_SRC));
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error("Program link error: " + gl.getProgramInfoLog(prog));
  }
  return prog;
}

async function solveWebGL2(gl, challengeHex, difficulty) {
  const canvas = gl.canvas;
  canvas.width = BATCH_SIZE;
  canvas.height = BATCH_SIZE;
  gl.viewport(0, 0, BATCH_SIZE, BATCH_SIZE);

  const prog = createProgram(gl);
  gl.useProgram(prog);

  // Full-screen quad
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  // FBO + texture
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, BATCH_SIZE, BATCH_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  // Uniforms
  const uOffset    = gl.getUniformLocation(prog, "uOffset");
  const uChallenge0 = gl.getUniformLocation(prog, "uChallenge0");
  const uChallenge1 = gl.getUniformLocation(prog, "uChallenge1");
  const uDifficulty = gl.getUniformLocation(prog, "uDifficulty");

  const c32 = challengeToU32Array(challengeHex);
  gl.uniform4uiv(uChallenge0, [c32[0], c32[1], c32[2], c32[3]]);
  gl.uniform4uiv(uChallenge1, [c32[4], c32[5], c32[6], c32[7]]);
  gl.uniform1ui(uDifficulty, difficulty);

  const pixels = new Uint8Array(BATCH_SIZE * BATCH_SIZE * 4);
  const deadline = Date.now() + TIMEOUT_MS;
  const batchNonces = BATCH_SIZE * BATCH_SIZE;

  for (let offset = 0; offset < 0xFFFFFFFF; offset += batchNonces) {
    if (Date.now() > deadline) throw new Error("TIMEOUT");

    gl.uniform1ui(uOffset, offset >>> 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, BATCH_SIZE, BATCH_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i], g = pixels[i+1], b = pixels[i+2], a = pixels[i+3];
      if (r !== 0 || g !== 0 || b !== 0 || a !== 0) {
        return (r << 24 | g << 16 | b << 8 | a) >>> 0;
      }
    }

    // 让出主线程
    await new Promise(resolve => setTimeout(resolve, 0));
    const pct = Math.min(99, Math.round(offset / 0xFFFFFF * 100));
    setStatus(`正在自动验证… ${pct}%`);
  }

  throw new Error("TIMEOUT");
}

main();
