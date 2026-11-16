// Builds optional local media for the mock adapter (public/mock/, gitignored):
//   sermon_proxy.mp4  - 6 min 540p proxy cut from a real sermon
//   illus/*.jpg       - 12 library illustrations (resized)
//   audio/*.mp3       - short music beds + SFX previews
// Usage: node scripts/make-mock-media.mjs [sermon.mp4] [startSeconds] [illustrationsDir]
// Without media the UI still works (placeholders), this just makes screenshots realistic.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public', 'mock')
mkdirSync(join(out, 'illus'), { recursive: true })
mkdirSync(join(out, 'audio'), { recursive: true })

function ff(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + args.join(' '))
}

function largestMp4(dir) {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.mp4'))
    .map((f) => ({ f: join(dir, f), s: statSync(join(dir, f)).size }))
    .sort((a, b) => b.s - a.s)
  return files[0]?.f ?? null
}

const sermon = process.argv[2] ?? process.env.VIKU_MOCK_SOURCE ?? largestMp4(join(homedir(), 'Downloads'))
const start = Number(process.argv[3] ?? process.env.VIKU_MOCK_START ?? 3000)
const illusDir = process.argv[4] ?? join(homedir(), 'Downloads', 'Salvation reels', 'illustrations')

if (sermon && existsSync(sermon)) {
  console.log(`proxy: ${sermon} @ ${start}s`)
  ff(['-ss', String(start), '-i', sermon, '-t', '360', '-vf', 'scale=960:540', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', join(out, 'sermon_proxy.mp4')])
} else {
  console.log('no sermon video found - skipping proxy')
}

const names = [
  '01-offering-money', '02-early-to-church', '03-kneeling-duty', '04-fasting', '05-first-believer', '06-rituals-candles',
  '07-endless-stairs', '08-pride-mirror', '09-empty-tomb', '10-shepherd-hills', '11-victory-hill', '12-cave-light'
]
const imgs = []
if (existsSync(illusDir)) {
  for (const sub of readdirSync(illusDir)) {
    const p = join(illusDir, sub)
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) if (/\.(png|jpe?g)$/i.test(f)) imgs.push(join(p, f))
  }
}
names.forEach((n, i) => {
  const src = imgs[(i * 3) % Math.max(1, imgs.length)]
  if (!src) return
  ff(['-i', src, '-vf', 'scale=540:-2', '-q:v', '4', join(out, 'illus', `${n}.jpg`)])
})
console.log(`illustrations: ${Math.min(names.length, imgs.length)}`)

// soft music beds (synth chords) + sfx previews, all short
const chords = { 'hopeful-dawn': [220, 277.18, 329.63], 'still-waters': [196, 246.94, 293.66], 'rise-again': [174.61, 220, 261.63], 'morning-mercy': [246.94, 311.13, 369.99], 'uplifting-worship-bed-01': [261.63, 329.63, 392] }
for (const [name, fs] of Object.entries(chords)) {
  const expr = fs.map((f) => `0.12*sin(2*PI*${f}*t)*(0.6+0.4*sin(2*PI*0.25*t))`).join('+')
  ff(['-f', 'lavfi', '-i', `aevalsrc=${expr}:s=44100:d=20`, '-af', 'afade=t=in:d=1.5,afade=t=out:st=17:d=3', '-b:a', '96k', join(out, 'audio', `${name}.mp3`)])
}
const sfx = { impact_low: 'aevalsrc=0.9*sin(2*PI*48*t)*exp(-3*t):s=44100:d=1.8', air_swell: 'anoisesrc=d=1.2:c=pink:a=0.3,afade=t=in:d=1,lowpass=f=3000', soft_whoosh: 'anoisesrc=d=0.9:c=pink:a=0.25,afade=t=in:d=0.4,afade=t=out:st=0.45:d=0.45,bandpass=f=900', sub_drop: 'aevalsrc=0.8*sin(2*PI*(70-20*t)*t)*exp(-1.5*t):s=44100:d=2.2', paper_turn: 'anoisesrc=d=0.7:c=white:a=0.15,afade=t=out:st=0.2:d=0.5,highpass=f=2000' }
for (const [name, src] of Object.entries(sfx)) ff(['-f', 'lavfi', '-i', src, '-b:a', '96k', join(out, 'audio', `${name}.mp3`)])
console.log('audio done ->', out)
