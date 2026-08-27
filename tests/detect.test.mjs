// Unit-test findEnglishSub() against the tricky layouts from real libraries.
import fs from "node:fs";
import { findEnglishSub } from "../subtitles-fetcher.mjs";

const ROOT = "cache/detect-tests";
fs.rmSync(ROOT, { recursive: true, force: true });

const mk = (p, content = "") => {
  fs.mkdirSync(ROOT + "/" + p.slice(0, p.lastIndexOf("/")), { recursive: true });
  if (!p.endsWith("/")) fs.writeFileSync(`${ROOT}/${p}`, content);
};

const bigSrt = Array.from({ length: 300 }, (_, i) =>
  `${i + 1}\n00:${String(Math.floor(i / 20)).padStart(2, "0")}:${String((i * 3) % 60).padStart(2, "0")},000 --> 00:00:05,000\nHello there, general dialogue line ${i}.\n`).join("\n");
const smallRealSrt = Array.from({ length: 40 }, (_, i) =>
  `${i + 1}\n00:0${i % 9}:12,000 --> 00:0${i % 9}:14,500\nShort and sweet line number ${i}.\n`).join("\n");
const fakeHtml = "<html><head><title>429 Too Many Requests</title></head><body>Slow down! error page</body></html>";
const arabicSrt = Array.from({ length: 60 }, (_, i) =>
  `${i + 1}\n00:00:${String(i % 60).padStart(2, "0")},000 --> 00:00:04,000\nمرحبا بك في هذا الحوار التجريبي رقم ${i} من اثنين.\n`).join("\n");
const chineseSrt = Array.from({ length: 60 }, (_, i) =>
  `${i + 1}\n00:00:${String(i % 60).padStart(2, "0")},000 --> 00:00:04,000\n这是一段测试字幕的第${i}行内容，用于检测。\n`).join("\n");

const cases = [];
function t(name, videoRel, want) {
  const got = findEnglishSub(`${ROOT}/${videoRel}`, {});
  const ok = want === null ? got === null : !!got && got.source === want.src && (!want.note || String(got.note).includes(want.note));
  cases.push([ok ? "PASS" : "FAIL", name, got ? `${got.source}:${got.note} -> ${got.path.split("/").slice(-2).join("/")}` : "null"]);
}

/* ── case family A: plain sidecars ─────────────────────────────── */
mk("A/Movie (2020)/Movie.2020.mkv", "");
mk("A/Movie (2020)/Movie.2020.srt", bigSrt);
t("big healthy sidecar covers", "A/Movie (2020)/Movie.2020.mkv", null || { src: "sidecar" });

mk("B/Fake/film.mkv", ""); mk("B/Fake/film.srt", fakeHtml);
t("fake html sidecar does NOT cover", "B/Fake/film.mkv", null);

mk("C/Tiny Real/tinyreal.mkv", ""); mk("C/Tiny Real/tinyreal.srt", smallRealSrt);
t("tiny-but-genuine srt covers", "C/Tiny Real/tinyreal.mkv", { src: "sidecar", note: "cues" });

mk("D/Oth_lang/movie.mkv", ""); mk("D/Oth_lang/movie.ar.srt", arabicSrt);
t(".ar-tagged sidecar does NOT cover", "D/Oth_lang/movie.mkv", null);

mk("E/En_tag/movie.mkv", ""); mk("E/En_tag/movie.en.srt", bigSrt);
t(".en-tagged sidecar covers", "E/En_tag/movie.mkv", { src: "sidecar" });

/* ── case family B: bundled subs folders (user-reported layout) ── */
mk("F/Movie.X/moviesubs/Movie.X.mkv", "", );
fs.mkdirSync(`${ROOT}/F/Movie.X/subs`, { recursive: true });
fs.writeFileSync(`${ROOT}/F/Movie.X/Movie.X.mkv`, "");
fs.writeFileSync(`${ROOT}/F/Movie.X/Movie.X.srt`, fakeHtml);              // decoy stub
fs.writeFileSync(`${ROOT}/F/Movie.X/subs/Arabic.srt`, arabicSrt);
fs.writeFileSync(`${ROOT}/F/Movie.X/subs/English.srt`, bigSrt);
t("subs-dir English beats fake stub", "F/Movie.X/Movie.X.mkv", { src: "subdir" });

mk("G/Serious/show.mkv", "");
mk("G/Serious/Subs/Arabic.srt", arabicSrt);
mk("G/Serious/Subs/chinese.srt", chineseSrt);
t("only foreign in Subs ⇒ still missing", "G/Serious/show.mkv", null);

mk("H/Anime/[Group] ep 01 (720p).mkv", "");
mk("H/Anime/Subs/[Group] ep 01 (720p).ass", bigSrt.replace(/-->/g, "-->"));   // .ass format w/ srt-ish timing lines? ass uses Dialogue:
// note: .ass real files don't contain '-->'… make this one genuinely untagged latin .srt instead:
fs.rmSync(`${ROOT}/H/Anime/Subs`, { recursive: true, force: true });
mk("H/Anime/Subs/[Group] ep01.srt", smallRealSrt);
t("untagged latin srt inside Subs covers", "H/Anime/[Group] ep 01 (720p).mkv", { src: "subdir" });

/* nested deeper pack: subs/SDH/english/eng.srt */
mk("I/Nested/nested.mkv", "");
mk("I/Nested/subs/SDH-English/eng.srt", smallRealSrt);
t("nested sub-folder english covers", "I/Nested/nested.mkv", { src: "subdir" });

let fails = 0;
for (const [st, name, info] of cases) {
  if (st === "FAIL") fails++;
  console.log(`${st === "PASS" ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m"} ${name}${info ? DIM("   -> " + info) : ""}`);
}
console.log(fails ? `\x1b[31m${fails} FAILURES\x1b[0m` : "\x1b[32mALL PASS\x1b[0m");
function DIM(s) { return `\x1b[2m${s}\x1b[0m`; }
process.exitCode = fails ? 1 : 0;
