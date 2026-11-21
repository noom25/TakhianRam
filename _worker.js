/**
 * _worker.js — ltaxmap (เก็บข้อมูลบน R2)
 * เวอร์ชัน 2.1 — 21 พ.ย. 2569
 *
 * ไฟล์นี้เหมือนกันทุกตัวอักษรในทุก อบต. — ไม่ต้องแก้อะไรเลย
 * รหัส อบต. ตั้งที่ "vars": { "ABT": "..." } ใน wrangler.jsonc ของแต่ละ repo
 *
 * โครงสร้างบน R2 — หนึ่งโฟลเดอร์ต่อหนึ่ง อบต. อยู่ใน bucket เดียวกัน
 *   data/<abt>/parcel.geojson        ข้อมูลแปลง (แก้ไขได้จากเว็บ)
 *   data/<abt>/building.geojson      ชั้นข้อมูลอื่นๆ
 *   pt13/<abt>/06C032.pdf            ใบ ผ.ท.13 รายแปลง
 *   backup/<abt>/2569-11-21/...      สำรองรายวัน เก็บ 30 วัน
 *
 * ความเข้ากันได้กับของเดิม
 *   - หน้าเว็บที่ส่ง ?abt=takhianram มา ใช้ค่านั้น (แบบ takhianram/lalom)
 *   - หน้าเว็บที่ไม่ส่งมา ใช้ค่า vars.ABT (แบบ map/ปรือใหญ่) จึงไม่ต้องแก้หน้าเว็บเลย
 *   - ถ้า R2 ยังไม่มีไฟล์ จะตกไปใช้ KV เดิมหรือไฟล์ static เดิมอัตโนมัติ
 *
 * เส้นทาง
 *   GET  /data/<ไฟล์>.geojson    ชั้นข้อมูล (R2 → ถ้าไม่มีใช้ static เดิม)
 *   GET  /api/load[?abt=]        ข้อมูลแปลงล่าสุด (R2 → ถ้าไม่มีใช้ KV เดิม)
 *   POST /api/save[?abt=]        บันทึกข้อมูลแปลง
 *   GET  /reports/<รหัส>.<ext>   ใบ ผ.ท.13 (R2 → ถ้าไม่มีใช้ static เดิม)
 *   GET  /admin/...              เครื่องมือผู้ดูแล ต้องมี ?token=
 */

/* ====================== ตั้งค่า ====================== */

// รหัส อบต. มาจาก vars.ABT ใน wrangler.jsonc — ถ้าไม่ได้ตั้งไว้ใช้ค่านี้
const FALLBACK_ABT = "prueyai";

// รหัสที่อนุญาต กันพิมพ์ผิดแล้วไปสร้างโฟลเดอร์มั่วบน R2
const ALLOWED_ABT = ["prueyai", "ltaxmap", "takhianram", "lalom"];

const RETENTION_DAYS = 30;        // เก็บ backup ย้อนหลังกี่วัน
const PARCEL_FILE = "parcel.geojson";
const DATA_CACHE_SECONDS = 3600;  // cache ชั้นข้อมูลที่ไม่ค่อยเปลี่ยน
const MAX_UPLOAD = 25 * 1024 * 1024;

const PT13_EXT = ["pdf", "png", "jpg"];
const PT13_TYPE = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg" };

/* ====================== ทางเข้าหลัก ====================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);

    try {
      if (path === "/api/save" && request.method === "POST") return await handleSave(request, env, url);
      if (path === "/api/load" && request.method === "GET")  return await handleLoad(env, url);

      if (path.startsWith("/data/"))    return await serveData(request, env, ctx, url, path.slice(6));
      if (path.startsWith("/reports/")) return await servePT13(request, env, url, path.slice(9));
      if (path.startsWith("/admin/"))   return await adminRoute(request, env, url, path);
    } catch (err) {
      return jsonResponse({ error: "ผิดพลาด: " + ((err && err.message) || err) }, 500);
    }

    // ไม่ใช่เส้นทางของเรา → เสิร์ฟไฟล์ static ตามปกติ
    return env.ASSETS.fetch(request);
  },

  // สำรองอัตโนมัติทุกคืน (ตั้งเวลาใน wrangler.jsonc)
  async scheduled(event, env, ctx) {
    const abt = (env.ABT && ALLOWED_ABT.includes(env.ABT)) ? env.ABT : FALLBACK_ABT;
    ctx.waitUntil(makeBackup(env, abt));
  },
};

/* ====================== รหัส อบต. ====================== */

function abtOf(url, env) {
  const q = url.searchParams.get("abt");
  if (q && ALLOWED_ABT.includes(q)) return q;          // หน้าเว็บระบุมา (แบบ takhianram/lalom)
  if (env && env.ABT && ALLOWED_ABT.includes(env.ABT)) return env.ABT;   // ตั้งใน wrangler.jsonc
  return FALLBACK_ABT;
}

// คีย์ใน KV เดิม ต่างกันสองแบบ รองรับทั้งคู่ตอนย้าย
function kvKeys(abt) {
  return [`abt-${abt}:${PARCEL_FILE}`, PARCEL_FILE];
}

/* ====================== ชั้นข้อมูลแผนที่ ====================== */

async function serveData(request, env, ctx, url, name) {
  if (!name) return jsonResponse({ error: "ไม่ได้ระบุชื่อไฟล์" }, 400);

  const abt = abtOf(url, env);
  const cacheable = name !== PARCEL_FILE;   // parcel เปลี่ยนทุกวัน ห้าม cache

  if (cacheable) {
    const hit = await caches.default.match(request);
    if (hit) return hit;
  }

  const obj = await env.BUCKET.get(`data/${abt}/${name}`);

  // R2 ยังไม่มีไฟล์นี้ → ใช้ไฟล์เดิมใน public/data/ ไปก่อน
  if (!obj) return env.ASSETS.fetch(request);

  const res = new Response(obj.body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "ETag": obj.httpEtag,
      "Cache-Control": cacheable ? `public, max-age=${DATA_CACHE_SECONDS}` : "no-store",
    },
  });

  if (cacheable) ctx.waitUntil(caches.default.put(request, res.clone()));
  return res;
}

/* ====================== ข้อมูลแปลง โหลด/บันทึก ====================== */

async function handleLoad(env, url) {
  const abt = abtOf(url, env);

  const obj = await env.BUCKET.get(`data/${abt}/${PARCEL_FILE}`);
  if (obj) {
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/json",
        "ETag": obj.httpEtag,
        "Cache-Control": "no-store",
      },
    });
  }

  // ยังไม่ได้ย้ายขึ้น R2 → อ่านจาก KV เดิมไปก่อน เว็บจึงไม่สะดุดระหว่างย้าย
  if (env.PARCEL_KV) {
    for (const k of kvKeys(abt)) {
      const data = await env.PARCEL_KV.get(k);
      if (data) {
        return new Response(data, {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
    }
  }

  return jsonResponse({ error: "ไม่พบข้อมูล" }, 404);
}

async function handleSave(request, env, url) {
  const abt = abtOf(url, env);

  const geojson = await request.json();
  if (!geojson || !geojson.features) {
    return jsonResponse({ error: "ข้อมูล GeoJSON ไม่ถูกต้อง" }, 400);
  }

  const dataStr = JSON.stringify(geojson);
  const key = `data/${abt}/${PARCEL_FILE}`;
  const opts = { httpMetadata: { contentType: "application/json; charset=utf-8" } };

  // ถ้าหน้าเว็บส่ง If-Match มา = บันทึกเฉพาะเมื่อยังไม่มีใครแก้
  // ไม่ส่งมาก็บันทึกทับเหมือนพฤติกรรมเดิมทุกอย่าง ของเดิมจึงไม่พัง
  const ifMatch = request.headers.get("if-match");
  if (ifMatch && ifMatch !== "*") {
    opts.onlyIf = { etagMatches: ifMatch.replace(/^W\//, "").replace(/"/g, "") };
  }

  const put = await env.BUCKET.put(key, dataStr, opts);

  if (!put) {
    const cur = await env.BUCKET.head(key);
    return jsonResponse({
      error: "มีคนอื่นบันทึกข้อมูลนี้ไปแล้วระหว่างที่คุณกำลังแก้\n" +
             "กรุณารีเฟรชหน้าเว็บแล้วแก้ใหม่ เพื่อไม่ให้งานของอีกฝ่ายหาย",
      conflict: true,
      currentEtag: cur ? cur.httpEtag : null,
    }, 409);
  }

  // สำรองรายวัน เขียนทับไฟล์ของวันเดียวกัน
  await env.BUCKET.put(`backup/${abt}/${thaiDate(0)}/${PARCEL_FILE}`, dataStr, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  try {
    await pruneBackups(env, abt);
  } catch (e) {
    console.warn("ลบ backup เก่าไม่สำเร็จ:", e.message);
  }

  return jsonResponse({
    message: `✅ บันทึกเรียบร้อย (อบต: ${abt})`,
    count: geojson.features.length,
    etag: put.httpEtag,
  });
}

/* ====================== ใบ ผ.ท.13 ====================== */
// เก็บที่ pt13/<abt>/<รหัสแปลง>.<นามสกุล>
// หน้าเว็บยังขอ /reports/06C032.png เหมือนเดิม — บน R2 เป็น .pdf ก็ส่ง .pdf ให้

async function servePT13(request, env, url, rest) {
  if (request.method === "POST") return uploadPT13(request, env, url, rest);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: "method ไม่รองรับ" }, 405);
  }

  const abt = abtOf(url, env);
  const stem = rest.replace(/\.[A-Za-z0-9]{1,8}$/, "");    // ตัดนามสกุลที่ขอมา
  if (!stem) return env.ASSETS.fetch(request);

  for (const ext of PT13_EXT) {
    const obj = await env.BUCKET.get(`pt13/${abt}/${stem}.${ext}`);
    if (!obj) continue;

    return new Response(obj.body, {
      headers: {
        "Content-Type": PT13_TYPE[ext],
        "Content-Disposition": `attachment; filename="${stem}.${ext}"`,
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  // R2 ยังไม่มี → ใช้ไฟล์เดิมใน public/reports/
  return env.ASSETS.fetch(request);
}

async function uploadPT13(request, env, url, rest) {
  if (!isAdmin(request, env)) {
    return jsonResponse({ error: "ต้องมีสิทธิ์ผู้ดูแลจึงจะอัปโหลดได้" }, 403);
  }

  const abt = abtOf(url, env);
  const sent = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = sent === "application/pdf" ? "pdf"
            : sent === "image/png"       ? "png"
            : (sent === "image/jpeg" || sent === "image/jpg") ? "jpg" : null;
  if (!ext) return jsonResponse({ error: "รับเฉพาะไฟล์ PDF, PNG และ JPG" }, 415);

  const stem = rest.replace(/\.[A-Za-z0-9]{1,8}$/, "").replace(/[^\w.-]/g, "_");
  if (!stem) return jsonResponse({ error: "ไม่ได้ระบุรหัสแปลง" }, 400);

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return jsonResponse({ error: "ไฟล์ว่าง" }, 400);
  if (body.byteLength > MAX_UPLOAD) {
    return jsonResponse({ error: "ไฟล์ใหญ่เกิน " + MAX_UPLOAD / 1048576 + " MB" }, 413);
  }

  await env.BUCKET.put(`pt13/${abt}/${stem}.${ext}`, body, {
    httpMetadata: { contentType: PT13_TYPE[ext] },
    customMetadata: { parcel: stem, abt, at: new Date().toISOString() },
  });

  return jsonResponse({ ok: true, key: `pt13/${abt}/${stem}.${ext}`, size: body.byteLength });
}

/* ====================== สำรองและกู้คืน ====================== */

function thaiDate(offsetDays) {
  const t = Date.now() + 7 * 3600 * 1000 - (offsetDays || 0) * 86400 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

async function makeBackup(env, abt) {
  const date = thaiDate(0);
  const src = await env.BUCKET.list({ prefix: `data/${abt}/`, limit: 1000 });
  let n = 0;

  for (const o of src.objects) {
    if (o.size === 0) continue;          // ไฟล์ว่าง ไม่เอาไปทับ backup ที่ดีอยู่
    const name = o.key.split("/").pop();
    const obj = await env.BUCKET.get(o.key);
    if (!obj) continue;
    await env.BUCKET.put(`backup/${abt}/${date}/${name}`, obj.body);
    n++;
  }

  const removed = await pruneBackups(env, abt);
  console.log(`[backup] ${abt} ${date} สำรอง ${n} ไฟล์ ลบของเก่า ${removed} ไฟล์`);
  return { abt, date, สำรอง: n, ลบของเก่า: removed };
}

async function pruneBackups(env, abt) {
  const cutoff = thaiDate(RETENTION_DAYS);
  const list = await env.BUCKET.list({ prefix: `backup/${abt}/`, limit: 1000 });
  let removed = 0;

  for (const o of list.objects) {
    const d = o.key.split("/")[2];       // backup/<abt>/<วันที่>/<ไฟล์>
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) {
      await env.BUCKET.delete(o.key);
      removed++;
    }
  }
  return removed;
}

/* ====================== เครื่องมือผู้ดูแล ====================== */

function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  if (request.headers.get("x-admin-token") === env.ADMIN_TOKEN) return true;
  try {
    return new URL(request.url).searchParams.get("token") === env.ADMIN_TOKEN;
  } catch (e) {
    return false;
  }
}

async function adminRoute(request, env, url, path) {
  if (!isAdmin(request, env)) return jsonResponse({ error: "token ไม่ถูกต้อง" }, 403);

  const abt = abtOf(url, env);
  const run = url.searchParams.get("run") === "1";

  /* ย้าย parcel.geojson จาก KV มา R2 — ใช้ครั้งเดียวตอนย้าย */
  if (path === "/admin/migrate") {
    if (!env.PARCEL_KV) return jsonResponse({ error: "ไม่ได้ผูก PARCEL_KV ใน wrangler.jsonc" }, 500);

    let data = null, from = null;
    for (const k of kvKeys(abt)) {
      data = await env.PARCEL_KV.get(k);
      if (data) { from = k; break; }
    }
    if (!data) return jsonResponse({ error: `ไม่พบข้อมูลของ ${abt} ใน KV`, ลองคีย์: kvKeys(abt) }, 404);

    const to = `data/${abt}/${PARCEL_FILE}`;
    if (!run) return jsonResponse({ ย้ายจริงหรือยัง: false, จาก: from, ไปที่: to, ขนาด: data.length });

    await env.BUCKET.put(to, data, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    return jsonResponse({ ok: true, จาก: from, ไปที่: to, ขนาด: data.length });
  }

  /* สำรองเดี๋ยวนี้ */
  if (path === "/admin/backup") {
    return jsonResponse(Object.assign({ ok: true }, await makeBackup(env, abt)));
  }

  /* ดูรายการชุดสำรอง */
  if (path === "/admin/backups") {
    const list = await env.BUCKET.list({ prefix: `backup/${abt}/`, limit: 1000 });
    const byDate = {};
    for (const o of list.objects) {
      const d = o.key.split("/")[2];
      if (!byDate[d]) byDate[d] = { วันที่: d, ไฟล์: [], รวมขนาด: 0 };
      byDate[d].ไฟล์.push(o.key.split("/").pop());
      byDate[d].รวมขนาด += o.size;
    }
    return jsonResponse({
      ok: true,
      อบต: abt,
      เก็บย้อนหลัง: RETENTION_DAYS + " วัน",
      ชุดสำรอง: Object.keys(byDate).sort().reverse().map((d) => byDate[d]),
    });
  }

  /* กู้คืน — เก็บของปัจจุบันไว้ก่อนเสมอ */
  if (path === "/admin/restore") {
    const date = url.searchParams.get("date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
      return jsonResponse({ error: "ต้องระบุ date=YYYY-MM-DD" }, 400);
    }

    const prefix = `backup/${abt}/${date}/`;
    const list = await env.BUCKET.list({ prefix, limit: 1000 });
    const names = list.objects.map((o) => o.key.slice(prefix.length));
    if (!names.length) return jsonResponse({ error: "ไม่พบชุดสำรองของวันที่ " + date }, 404);
    if (!run) return jsonResponse({ กู้จริงหรือยัง: false, อบต: abt, จะกู้: names });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const done = [];

    for (const name of names) {
      const cur = await env.BUCKET.get(`data/${abt}/${name}`);
      if (cur) await env.BUCKET.put(`backup/${abt}/before-restore-${stamp}/${name}`, cur.body);

      const src = await env.BUCKET.get(prefix + name);
      if (!src) continue;
      await env.BUCKET.put(`data/${abt}/${name}`, src.body, {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      done.push(name);
    }

    return jsonResponse({
      ok: true,
      อบต: abt,
      กู้จาก: date,
      กู้แล้ว: done,
      ของเดิมเก็บไว้ที่: `backup/${abt}/before-restore-${stamp}/`,
    });
  }

  /* ดูว่ามีอะไรอยู่บน R2 บ้าง */
  if (path === "/admin/list") {
    const prefix = url.searchParams.get("prefix") || `data/${abt}/`;
    const list = await env.BUCKET.list({ prefix, limit: 1000 });
    return jsonResponse({
      ok: true,
      prefix,
      จำนวน: list.objects.length,
      ไฟล์: list.objects.map((o) => ({ key: o.key, ขนาด: o.size, แก้ไขล่าสุด: o.uploaded })),
    });
  }

  return jsonResponse({ error: "ไม่รู้จักคำสั่งนี้" }, 404);
}

/* ====================== ตัวช่วย ====================== */

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
