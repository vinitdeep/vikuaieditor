// Realistic mock content (Odia / Hindi / English) used by the mock adapter and screenshots.
import type { BibleVerse, Candidate, Lang, LibraryImage, MusicMood, MusicTrack, Project, Reel, Settings, SfxItem, TranscriptLine } from './types'

export const MOCK_VIDEO = 'D:\\Sermons\\2026-11-09 Before the Foundation - Pastor Jacob Deep.mp4'
export const MOCK_VIDEO_HI = 'D:\\Sermons\\2026-10-26 Akele Nahin - Hindi service.mp4'
export const MOCK_PROXY = 'C:\\Users\\editor\\Viku\\projects\\p-btf\\proxy_540p.mp4'

const OR_LINES: [string, number?][] = [
  ['ପ୍ରଭୁଙ୍କ ନାମରେ ଆପଣ ସମସ୍ତଙ୍କୁ ସ୍ୱାଗତ।'],
  ['ଆଜି ଆମେ ଏଫିସୀୟ ପ୍ରଥମ ଅଧ୍ୟାୟ ଚାରି ପଦ ପଢ଼ିବା।'],
  ['ଜଗତର ମୂଳଦୁଆ ପୂର୍ବରୁ ସେ ଆମକୁ ମନୋନୀତ କଲେ।'],
  ['ଭାବନ୍ତୁ, ଆପଣ ଜନ୍ମ ହେବା ପୂର୍ବରୁ ପରମେଶ୍ୱର ଆପଣଙ୍କୁ ଜାଣିଥିଲେ।'],
  ['ଆପଣଙ୍କ ଅତୀତ ଆପଣଙ୍କୁ ପରିଭାଷିତ କରେ ନାହିଁ।', 0.71],
  ['ଲୋକମାନେ କହିପାରନ୍ତି ତୁମେ କିଛି ନୁହଁ।'],
  ['କିନ୍ତୁ ପରମେଶ୍ୱର କହନ୍ତି, ତୁମେ ମୋର ପ୍ରିୟ ସନ୍ତାନ।'],
  ['ହାଲେଲୁୟା! ଆପଣ ଜଣେ ବଛାଯାଇଥିବା ଲୋକ।'],
  ['ଶୟତାନ ହାରିସାରିଛି!'],
  ['କ୍ରୁସ ଉପରେ ଯୀଶୁ କହିଲେ, ସମାପ୍ତ ହେଲା।', 0.62],
  ['ସେହି ଦିନ ଠାରୁ ଅନ୍ଧକାରର କ୍ଷମତା ଭାଙ୍ଗିଗଲା।'],
  ['ତେଣୁ ଭୟ କରନ୍ତୁ ନାହିଁ, ଆପଣ ଏକା ନୁହଁନ୍ତି।'],
  ['ଆପଣଙ୍କ ପଡ଼ୋଶୀଙ୍କୁ କୁହନ୍ତୁ — ତୁମେ ମନୋନୀତ।', 0.8],
  ['ଆମେନ୍? ଆମେନ୍!', 0.55],
  ['ଦାଉଦ ଜଣେ ମେଷପାଳକ ବାଳକ ଥିଲେ।'],
  ['ତାଙ୍କ ପରିବାର ତାଙ୍କୁ ଭୁଲିଯାଇଥିଲେ।'],
  ['କିନ୍ତୁ ପରମେଶ୍ୱର ତାଙ୍କୁ ରାଜା ଭାବେ ଅଭିଷିକ୍ତ କଲେ।'],
  ['ପରମେଶ୍ୱର ମଣିଷ ପରି ବାହାର ଦେଖନ୍ତି ନାହିଁ, ସେ ହୃଦୟ ଦେଖନ୍ତି।'],
  ['ଆପଣଙ୍କ ପରିସ୍ଥିତି ଯେତେ କଠିନ ହେଉ ପଛେ…'],
  ['ତାଙ୍କ ଯୋଜନା ଆପଣଙ୍କ ପାଇଁ ଭଲ।'],
  ['ଯିରିମିୟ ଊଣତିରିଶ ଅଧ୍ୟାୟ ଏଗାର ପଦ କହେ…'],
  ['ମୁଁ ତୁମ୍ଭ ପାଇଁ ଯେଉଁ ସଙ୍କଳ୍ପ କରିଅଛି, ତାହା ମୁଁ ଜାଣେ।'],
  ['ଶାନ୍ତିର ସଙ୍କଳ୍ପ, ଅମଙ୍ଗଳର ନୁହେଁ।'],
  ['ଆଜି ଯିଏ ନିରାଶ ଅନୁଭବ କରୁଛନ୍ତି, ଶୁଣନ୍ତୁ।'],
  ['ଆପଣଙ୍କ ଜୀବନ ଏକ ଦୁର୍ଘଟଣା ନୁହେଁ।'],
  ['ମୂଳଦୁଆ ପୂର୍ବରୁ ଆପଣଙ୍କ ନାମ ତାଙ୍କ ହୃଦୟରେ ଥିଲା।'],
  ['Amen. Praise the Lord.', 0.93],
  ['ମୁଁ ମୋ ଜୀବନର ଏକ ସାକ୍ଷ୍ୟ କହିବି।'],
  ['କଲେଜ ସମୟରେ ମୁଁ ବହୁତ ଏକାକୀ ଥିଲି।'],
  ['ସେତେବେଳେ ଜଣେ ଭାଇ ମୋ ପାଇଁ ପ୍ରାର୍ଥନା କଲେ।'],
  ['ସେହି ରାତିରେ ମୁଁ ଯୀଶୁଙ୍କ ଶାନ୍ତି ଅନୁଭବ କଲି।'],
  ['ସେ ମୋତେ କେବେ ଛାଡ଼ି ନାହାନ୍ତି।'],
  ['ସେ ଆପଣଙ୍କୁ ମଧ୍ୟ ଛାଡ଼ିବେ ନାହିଁ।'],
  ['ଗୀତସଂହିତା ତେଇଶ — ସଦାପ୍ରଭୁ ମୋହର ପାଳକ।'],
  ['ମୋହର ଅଭାବ ହେବ ନାହିଁ।'],
  ['ମୃତ୍ୟୁଚ୍ଛାୟାର ଉପତ୍ୟକା ଦେଇ ଗଲେ ମଧ୍ୟ…', 0.68],
  ['ମୁଁ କୌଣସି ଅମଙ୍ଗଳକୁ ଭୟ କରିବି ନାହିଁ।'],
  ['କାରଣ ତୁମ୍ଭେ ମୋହର ସଙ୍ଗରେ ଅଛ।'],
  ['ଆପଣ ବିଜୟୀ, କାରଣ ସେ ବିଜୟୀ।'],
  ['ଚାଲନ୍ତୁ ଆମେ ପ୍ରାର୍ଥନା କରିବା।']
]

const HI_LINES: [string, number?][] = [
  ['प्रभु के नाम में आप सबका स्वागत है।'],
  ['आज हम यशायाह इकतालीस अध्याय दस पद पढ़ेंगे।'],
  ['मत डर, क्योंकि मैं तेरे संग हूँ।'],
  ['बहुत लोग सोचते हैं कि वे अकेले हैं।'],
  ['लेकिन परमेसर कहता है, मैं तुझे कभी नहीं छोड़ूँगा।', 0.64],
  ['अकेले नहीं — परमेश्वर के साथ!'],
  ['जब एलिय्याह गुफा में छिपा था…'],
  ['उसे लगा कि सिर्फ़ वही बचा है।'],
  ['पर परमेश्वर ने कहा, सात हज़ार और हैं।'],
  ['आपकी लड़ाई आप अकेले नहीं लड़ रहे।'],
  ['यीशु ने कहा, मैं जगत के अन्त तक सदा तुम्हारे संग हूँ।'],
  ['आमीन? आमीन!', 0.5],
  ['अपने पड़ोसी से कहिए — तुम अकेले नहीं हो।', 0.78],
  ['जब मैं अस्पताल में था, मेरा परिवार दूर था।'],
  ['पर उस रात मैंने उसकी उपस्थिति महसूस की।'],
  ['उसका प्रेम आपकी परिस्थिति से बड़ा है।'],
  ['आज अपना बोझ उसके चरणों में रख दीजिए।'],
  ['वह आपको उठाएगा, वह आपको सँभालेगा।'],
  ['आप विजयी हैं, क्योंकि वह विजयी है।'],
  ['आइए, हम प्रार्थना करें।']
]

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function buildTranscript(lines: [string, number?][], fallbackLang: Lang, total: number): TranscriptLine[] {
  const rnd = seeded(lines.length * 97)
  const weights = lines.map(([t]) => 0.6 + t.length / 40 + rnd() * 0.4)
  const sum = weights.reduce((a, b) => a + b, 0)
  let t = 1.2
  const usable = total - 2.4
  return lines.map(([text, conf], i) => {
    const len = (weights[i] / sum) * usable
    const gap = 0.35 + rnd() * 0.5
    const start = t
    const end = t + len - gap
    t += len
    const isLatin = /^[\x20-\x7e]+$/.test(text)
    return { start: round(start), end: round(end), text, lang: isLatin ? 'en' : fallbackLang, conf: conf ?? round(0.86 + rnd() * 0.12) }
  })
}

const round = (n: number): number => Math.round(n * 100) / 100

export const MOCK_DURATION = 360

export function mockReelA(): Reel {
  return {
    id: 'r-satan-defeated',
    title: 'ଶୟତାନ ହାରିସାରିଛି!',
    sub: 'କ୍ରୁଶ ଉପରେ ଯୀଶୁ ଜିତିଲେ',
    language: 'or',
    segments: [
      [70.4, 79.2],
      [80.1, 92.6],
      [93.2, 104.8],
      [301.5, 313.9],
      [314.6, 322.4]
    ],
    crops: [
      { t0: 0, t1: 8.8, cx: 0.5, cw: 0.316, z: 1 },
      { t0: 8.8, t1: 21.3, cx: 0.5, cw: 0.316, z: 1.12 },
      { t0: 21.3, t1: 32.9, cx: 0.47, cw: 0.316, z: 1 },
      { t0: 32.9, t1: 45.3, cx: 0.52, cw: 0.42, z: 1 },
      { t0: 45.3, t1: 53.1, cx: 0.52, cw: 0.316, z: 1.12 }
    ],
    captions: [
      { t0: 0.3, t1: 3.6, text: 'ଶୟତାନ ହାରିସାରିଛି!', flags: [] },
      { t0: 3.8, t1: 8.6, text: 'କ୍ରୁସ ଉପରେ ଯୀଶୁ କହିଲେ, ସମାପ୍ତ ହେଲା।', flags: [{ start: 0, end: 5, reason: 'Bible vocabulary', suggest: 'କ୍ରୁଶ' }] },
      { t0: 8.9, t1: 13.4, text: 'ସେହି ଦିନ ଠାରୁ ଅନ୍ଧକାରର', flags: [] },
      { t0: 13.5, t1: 17.8, text: 'କ୍ଷମତା ଭାଙ୍ଗିଗଲା।', flags: [] },
      { t0: 17.9, t1: 21.2, text: 'ତେଣୁ ଭୟ କରନ୍ତୁ ନାହିଁ,', flags: [] },
      { t0: 21.4, t1: 26.6, text: 'ଆପଣ ଏକା ନୁହଁନ୍ତି।', flags: [] },
      { t0: 26.8, t1: 32.7, text: 'ଆପଣଙ୍କ ପଡ଼ୋଶୀଙ୍କୁ କୁହନ୍ତୁ — ତୁମେ ମନୋନୀତ।', flags: [] },
      { t0: 33.0, t1: 38.9, text: 'ସେ ମୋତେ କେବେ ଛାଡ଼ି ନାହାନ୍ତି।', flags: [] },
      { t0: 39.0, t1: 45.1, text: 'ସେ ଆପଣଙ୍କୁ ମଧ୍ୟ ଛାଡ଼ିବେ ନାହିଁ।', flags: [] },
      { t0: 45.4, t1: 53.0, text: 'ଆପଣ ବିଜୟୀ, କାରଣ ସେ ବିଜୟୀ।', flags: [] }
    ],
    verses: [
      { t0: 9.4, t1: 15.6, ref: 'ଯୋହନ ୧୯:୩୦', text: 'ଯୀଶୁ ସେହି ଅମ୍ଳରସ ଗ୍ରହଣ କରି କହିଲେ, ସମାପ୍ତ ହେଲା।', top_y: 300 },
      { t0: 46.0, t1: 52.2, ref: 'ରୋମୀୟ ୮:୩୭', text: 'ଯେ ଆମ୍ଭମାନଙ୍କୁ ପ୍ରେମ କଲେ, ତାହାଙ୍କ ଦ୍ୱାରା ଆମ୍ଭେମାନେ ବିଜୟୀରୁ ଅଧିକ।', top_y: 300 }
    ],
    cutaways: [
      { t0: 9.0, t1: 16.2, img: 'D:\\Viku\\library\\illustrations\\09-empty-tomb.png', z0: 1.0, z1: 1.1, pan: [0, -0.02] },
      { t0: 27.0, t1: 32.4, img: 'D:\\Viku\\library\\illustrations\\05-first-believer.png', z0: 1.04, z1: 1.12, pan: [0.02, 0] },
      {
        t0: 34.2,
        t1: 39.0,
        img: '',
        z0: 1.12,
        z1: 1.22,
        pan: [0, 0],
        why: { match: 0.62, threshold: 1.3, nearest: 'shepherd hills' },
        need: {
          prompt:
            'VERTICAL 9:16 portrait. Photorealistic cinematic still, Indian village at dawn: a shepherd carrying a tired lamb on his shoulders down a dusty path, warm low sun, gentle haze, no text, no logos.',
          slug: '04-carried-home',
          scene: 'a shepherd carrying a tired lamb home at dawn',
          text: 'ସେ ମୋତେ କେବେ ଛାଡ଼ି ନାହାନ୍ତି।',
          tags: ['shepherd', 'lamb', 'carried', 'home'],
          grade: 'warm golden-hour grade'
        }
      },
      { t0: 45.6, t1: 52.6, img: 'D:\\Viku\\library\\illustrations\\11-victory-hill.png', z0: 1.0, z1: 1.08, pan: [0, 0.01] }
    ],
    music: { path: 'D:\\Viku\\music\\Hopeful Dawn - piano and strings.mp3', gain_db: -19, start: 0, duck_db: -8 },
    sfx: [
      { name: 'impact_low', t: 0.2, gain_db: -8 },
      { name: 'air_swell', t: 8.4, gain_db: -14 },
      { name: 'air_swell', t: 26.5, gain_db: -14 },
      { name: 'air_swell', t: 45.2, gain_db: -14 }
    ],
    style: { caption_font: 'Noto Sans Oriya', caption_size: 66, title_style: 'gold-bar', voice_gain_db: 0 },
    thumbnail: { style: 'bold-gold', pose_t: 11.6, title: 'ଶୟତାନ ହାରିସାରିଛି!', sub: 'କ୍ରୁଶ ଉପରେ ଯୀଶୁ ଜିତିଲେ', verse: 'ଯୋହନ ୧୯:୩୦' },
    status: 'built',
    exports: []
  }
}

export function mockReelB(): Reel {
  return {
    id: 'r-before-foundation',
    title: 'ମୂଳଦୁଆ ପୂର୍ବରୁ ମନୋନୀତ',
    sub: 'ଆପଣଙ୍କ ଜୀବନ ଏକ ଦୁର୍ଘଟଣା ନୁହେଁ',
    language: 'or',
    segments: [
      [14.2, 27.9],
      [28.6, 41.0],
      [236.0, 251.5]
    ],
    crops: [
      { t0: 0, t1: 13.7, cx: 0.5, cw: 0.316, z: 1 },
      { t0: 13.7, t1: 26.1, cx: 0.5, cw: 0.316, z: 1.12 },
      { t0: 26.1, t1: 41.6, cx: 0.49, cw: 0.316, z: 1 }
    ],
    captions: [
      { t0: 0.2, t1: 4.8, text: 'ଜଗତର ମୂଳଦୁଆ ପୂର୍ବରୁ', flags: [] },
      { t0: 4.9, t1: 9.0, text: 'ସେ ଆମକୁ ମନୋନୀତ କଲେ।', flags: [] },
      { t0: 9.1, t1: 13.5, text: 'ପରମେଶ୍ୱର ଆପଣଙ୍କୁ ଜାଣିଥିଲେ।', flags: [] },
      { t0: 13.8, t1: 20.0, text: 'ଆପଣଙ୍କ ଅତୀତ ଆପଣଙ୍କୁ ପରିଭାଷିତ କରେ ନାହିଁ।', flags: [] },
      { t0: 20.1, t1: 26.0, text: 'ତୁମେ ମୋର ପ୍ରିୟ ସନ୍ତାନ।', flags: [] },
      { t0: 26.3, t1: 33.4, text: 'ଆପଣଙ୍କ ଜୀବନ ଏକ ଦୁର୍ଘଟଣା ନୁହେଁ।', flags: [] },
      { t0: 33.5, t1: 41.4, text: 'ଆପଣଙ୍କ ନାମ ତାଙ୍କ ହୃଦୟରେ ଥିଲା।', flags: [] }
    ],
    verses: [{ t0: 2.0, t1: 8.6, ref: 'ଏଫିସୀୟ ୧:୪', text: 'ସେ ଜଗତର ପତ୍ତନ ପୂର୍ବରୁ ଖ୍ରୀଷ୍ଟଙ୍କ ସହିତ ସଂଯୁକ୍ତ କରି ଆମ୍ଭମାନଙ୍କୁ ମନୋନୀତ କଲେ।', top_y: 300 }],
    cutaways: [{ t0: 1.6, t1: 9.0, img: 'D:\\Viku\\library\\illustrations\\07-endless-stairs.png', z0: 1.0, z1: 1.1, pan: [0, 0] }],
    music: { path: 'D:\\Viku\\music\\Still Waters - ambient pad.mp3', gain_db: -20, start: 0, duck_db: -8 },
    sfx: [{ name: 'impact_low', t: 0.2, gain_db: -8 }],
    style: { caption_font: 'Noto Sans Oriya', caption_size: 66, title_style: 'gold-bar', voice_gain_db: 0 },
    thumbnail: { style: 'verse-card', pose_t: 6.2, title: 'ମୂଳଦୁଆ ପୂର୍ବରୁ', sub: 'ଆପଣ ମନୋନୀତ', verse: 'ଏଫିସୀୟ ୧:୪' },
    status: 'rendered',
    exports: [{ path: 'D:\\Viku\\exports\\before-the-foundation\\ମୂଳଦୁଆ-ପୂର୍ବରୁ.mp4', thumbnail: 'D:\\Viku\\exports\\before-the-foundation\\ମୂଳଦୁଆ-ପୂର୍ବରୁ.jpg' }]
  }
}

export function mockReelHi(): Reel {
  return {
    id: 'r-not-alone',
    title: 'अकेले नहीं — परमेश्वर के साथ!',
    sub: 'मत डर, मैं तेरे संग हूँ',
    language: 'hi',
    segments: [
      [88.0, 100.4],
      [101.0, 117.2],
      [190.0, 205.5]
    ],
    crops: [
      { t0: 0, t1: 12.4, cx: 0.5, cw: 0.316, z: 1 },
      { t0: 12.4, t1: 28.6, cx: 0.5, cw: 0.316, z: 1.12 },
      { t0: 28.6, t1: 44.1, cx: 0.5, cw: 0.316, z: 1 }
    ],
    captions: [
      { t0: 0.2, t1: 4.0, text: 'अकेले नहीं — परमेश्वर के साथ!', flags: [] },
      { t0: 4.1, t1: 9.6, text: 'जब एलिय्याह गुफा में छिपा था…', flags: [] },
      { t0: 9.7, t1: 12.3, text: 'उसे लगा कि सिर्फ़ वही बचा है।', flags: [] },
      { t0: 12.5, t1: 19.0, text: 'पर परमेश्वर ने कहा, सात हज़ार और हैं।', flags: [] },
      { t0: 19.1, t1: 28.4, text: 'आपकी लड़ाई आप अकेले नहीं लड़ रहे।', flags: [] },
      { t0: 28.7, t1: 36.0, text: 'वह आपको उठाएगा, वह आपको सँभालेगा।', flags: [] },
      { t0: 36.1, t1: 44.0, text: 'आप विजयी हैं, क्योंकि वह विजयी है।', flags: [] }
    ],
    verses: [{ t0: 20.0, t1: 27.0, ref: 'यशायाह 41:10', text: 'मत डर, क्योंकि मैं तेरे संग हूँ, इधर-उधर मत ताक, क्योंकि मैं तेरा परमेश्वर हूँ।', top_y: 300 }],
    cutaways: [{ t0: 19.6, t1: 27.6, img: 'D:\\Viku\\library\\illustrations\\12-cave-light.png', z0: 1.0, z1: 1.1, pan: [0, 0] }],
    music: { path: 'D:\\Viku\\music\\Hopeful Dawn - piano and strings.mp3', gain_db: -19, start: 0, duck_db: -8 },
    sfx: [{ name: 'impact_low', t: 0.2, gain_db: -8 }],
    style: { caption_font: 'Noto Sans Devanagari', caption_size: 64, title_style: 'gold-bar', voice_gain_db: 0 },
    thumbnail: { style: 'bold-gold', pose_t: 3.0, title: 'अकेले नहीं!', sub: 'परमेश्वर के साथ', verse: 'यशायाह 41:10' },
    status: 'draft',
    exports: []
  }
}

export function mockProjects(): Project[] {
  return [
    {
      id: 'p-btf',
      name: 'ମୂଳଦୁଆ ପୂର୍ବରୁ — Before the Foundation',
      video_path: MOCK_VIDEO,
      duration: MOCK_DURATION,
      fps: 30,
      language: 'or',
      proxy: MOCK_PROXY,
      proxy_offset: 0,
      proxies: [],
      width: 1280,
      height: 720,
      wav16: 'C:\\Users\\editor\\Viku\\projects\\p-btf\\audio_16k.wav',
      shots: [0, 64.2, 118.9, 182.5, 247.1, 301.0],
      pauses: [],
      transcript: buildTranscript(OR_LINES, 'or', MOCK_DURATION),
      reels: [mockReelA(), mockReelB()]
    },
    {
      id: 'p-akele',
      name: 'अकेले नहीं — Not Alone (Hindi service)',
      video_path: MOCK_VIDEO_HI,
      duration: MOCK_DURATION,
      fps: 30,
      language: 'hi',
      proxy: MOCK_PROXY,
      proxy_offset: 0,
      proxies: [],
      width: 1280,
      height: 720,
      wav16: 'C:\\Users\\editor\\Viku\\projects\\p-akele\\audio_16k.wav',
      shots: [0, 120, 240],
      pauses: [],
      transcript: buildTranscript(HI_LINES, 'hi', MOCK_DURATION),
      reels: [mockReelHi()]
    }
  ]
}

export function mockCandidates(projectId: string): Candidate[] {
  if (projectId === 'p-akele') {
    return [
      { id: 'c-h1', score: 0.91, title: 'अकेले नहीं — परमेश्वर के साथ!', segments: [[88, 100.4], [101, 117.2]], reasons: ['victory lexicon', 'direct address', 'ends on hope', 'Isa 41:10'], language: 'hi' },
      { id: 'c-h2', score: 0.82, title: 'आपकी लड़ाई आप अकेले नहीं लड़ रहे', segments: [[150, 176]], reasons: ['high energy', 'direct address'], language: 'hi' },
      { id: 'c-h3', score: 0.64, title: 'उस रात मैंने उसकी उपस्थिति महसूस की', segments: [[240, 268]], reasons: ['testimony', 'pitch variance'], language: 'hi' }
    ]
  }
  return [
    { id: 'c-1', score: 0.94, title: 'ଶୟତାନ ହାରିସାରିଛି!', segments: [[70.4, 79.2], [80.1, 92.6], [93.2, 104.8]], reasons: ['victory lexicon', 'high energy', 'scripture: John 19:30', 'ends on hope'], language: 'or' },
      { id: 'c-2', score: 0.88, title: 'ମୂଳଦୁଆ ପୂର୍ବରୁ ମନୋନୀତ', segments: [[14.2, 27.9], [28.6, 41.0]], reasons: ['scripture: Eph 1:4', 'direct address', 'ends on hope'], language: 'or' },
    { id: 'c-3', score: 0.81, title: 'ଆପଣଙ୍କ ଜୀବନ ଏକ ଦୁର୍ଘଟଣା ନୁହେଁ', segments: [[205.0, 232.0]], reasons: ['direct address', 'encouragement', 'pitch variance'], language: 'or' },
    { id: 'c-4', score: 0.74, title: 'ସଦାପ୍ରଭୁ ମୋହର ପାଳକ', segments: [[296.0, 330.0]], reasons: ['scripture: Ps 23', 'calm delivery'], language: 'or' },
    { id: 'c-5', score: 0.66, title: 'ଦାଉଦ — ଭୁଲିଯାଇଥିବା ବାଳକ', segments: [[118.0, 150.0]], reasons: ['story', 'pitch variance'], language: 'or' },
    { id: 'c-6', score: 0.41, title: 'ଆପଣଙ୍କ ପଡ଼ୋଶୀଙ୍କୁ କୁହନ୍ତୁ', segments: [[104.0, 118.0]], reasons: ['crowd call-and-response', 'low content'], language: 'or' }
  ]
}

export const MOCK_LIBRARY: LibraryImage[] = [
  ['01-offering-money', ['offering', 'works', 'money']],
  ['02-early-to-church', ['church', 'morning', 'works']],
  ['03-kneeling-duty', ['prayer', 'kneeling', 'duty']],
  ['04-fasting', ['fasting', 'works', 'empty plate']],
  ['05-first-believer', ['faith', 'believer', 'light']],
  ['06-rituals-candles', ['ritual', 'candles', 'religion']],
  ['07-endless-stairs', ['stairs', 'striving', 'heaven']],
  ['08-pride-mirror', ['pride', 'mirror', 'self']],
  ['09-empty-tomb', ['resurrection', 'tomb', 'victory']],
  ['10-shepherd-hills', ['shepherd', 'psalm 23', 'sheep']],
  ['11-victory-hill', ['victory', 'cross', 'sunrise']],
  ['12-cave-light', ['elijah', 'cave', 'not alone']]
].map(([name, tags]) => ({
  path: `D:\\Viku\\library\\illustrations\\${name as string}.png`,
  name: name as string,
  tags: tags as string[],
  width: 1536,
  height: 2752
}))

export const MOCK_MUSIC: MusicTrack[] = [
  { path: 'D:\\Viku\\music\\viku_hopeful_s1.flac', name: 'viku_hopeful_s1.flac', duration: 90, mood: 'hopeful', source: 'viku', seed: 1 },
  { path: 'D:\\Viku\\music\\viku_victorious_s1.flac', name: 'viku_victorious_s1.flac', duration: 90, mood: 'victorious', source: 'viku', seed: 1 },
  { path: 'D:\\Viku\\music\\viku_reflective_s1.flac', name: 'viku_reflective_s1.flac', duration: 90, mood: 'reflective', source: 'viku', seed: 1 },
  { path: 'D:\\Viku\\music\\viku_prayerful_s1.flac', name: 'viku_prayerful_s1.flac', duration: 90, mood: 'prayerful', source: 'viku', seed: 1 },
  { path: 'D:\\Viku\\music\\viku_uplifting_s1.flac', name: 'viku_uplifting_s1.flac', duration: 90, mood: 'uplifting', source: 'viku', seed: 1 },
  { path: 'D:\\Viku\\music\\Hopeful Dawn - piano and strings.mp3', name: 'Hopeful Dawn', duration: 142, mood: 'hopeful', bpm: 72, source: 'library' },
  { path: 'D:\\Viku\\music\\Still Waters - ambient pad.mp3', name: 'Still Waters', duration: 188, mood: 'calm', bpm: 60, source: 'library' },
  { path: 'D:\\Viku\\music\\Rise Again - cinematic build.mp3', name: 'Rise Again', duration: 121, mood: 'triumphant', bpm: 90, source: 'library' },
  { path: 'D:\\Viku\\music\\Morning Mercy - acoustic guitar.mp3', name: 'Morning Mercy', duration: 156, mood: 'warm', bpm: 84, source: 'library' },
  { path: 'D:\\Viku\\music\\heygen\\uplifting-worship-bed-01.mp3', name: 'Uplifting worship bed', duration: 60, mood: 'uplifting', bpm: 76, source: 'heygen' }
]

export const MOCK_MOODS: MusicMood[] = [
  { id: 'hopeful', label: 'Hopeful piano + pad', desc: 'felt piano broken chords over a soft pad, I-V-vi-IV' },
  { id: 'victorious', label: 'Victorious strings swell', desc: 'string-pad swells, low boom on the downbeats' },
  { id: 'reflective', label: 'Reflective ambient', desc: 'slow sine pads and a drone, vi-IV-I-V' },
  { id: 'prayerful', label: 'Prayerful warm pad', desc: 'warm pad and low drone, very slow movement' },
  { id: 'uplifting', label: 'Uplifting pulse', desc: 'soft eighth-note pluck pulse, pad and bass' }
]

export const STARTER_LICENCE = 'Viku starter illustrations - AI-generated (Google Gemini / AI Studio) by the Viku project, free to use in Viku videos'

export const MOCK_SFX: SfxItem[] = [
  { name: 'impact_low', path: 'D:\\Viku\\sfx\\impact_low.wav', duration: 1.8, kind: 'impact' },
  { name: 'air_swell', path: 'D:\\Viku\\sfx\\air_swell.wav', duration: 1.2, kind: 'swell' },
  { name: 'soft_whoosh', path: 'D:\\Viku\\sfx\\soft_whoosh.wav', duration: 0.9, kind: 'transition' },
  { name: 'sub_drop', path: 'D:\\Viku\\sfx\\sub_drop.wav', duration: 2.2, kind: 'impact' },
  { name: 'paper_turn', path: 'D:\\Viku\\sfx\\paper_turn.wav', duration: 0.7, kind: 'foley' }
]

const V = (ref: string, text: string, lang: Lang): BibleVerse => ({ ref, text, lang })
export const MOCK_BIBLE: BibleVerse[] = [
  V('ଏଫିସୀୟ ୧:୪', 'ଯେପରି ଆମ୍ଭେମାନେ ତାହାଙ୍କ ସାକ୍ଷାତରେ ପ୍ରେମରେ ପବିତ୍ର ଓ ନିଷ୍କଳଙ୍କ ହେଉ, ଏଥିପାଇଁ ସେ ଜଗତର ପତ୍ତନ ପୂର୍ବରୁ ଖ୍ରୀଷ୍ଟଙ୍କ ସହିତ ସଂଯୁକ୍ତ କରି ଆମ୍ଭମାନଙ୍କୁ ମନୋନୀତ କଲେ।', 'or'),
  V('ଯୋହନ ୧୯:୩୦', 'ଯୀଶୁ ସେହି ଅମ୍ଳରସ ଗ୍ରହଣ କରି କହିଲେ, ସମାପ୍ତ ହେଲା, ପୁଣି ମସ୍ତକ ନତ କରି ଆତ୍ମା ସମର୍ପଣ କଲେ।', 'or'),
  V('ଯିରିମିୟ ୨୯:୧୧', 'କାରଣ ସଦାପ୍ରଭୁ କହନ୍ତି, ଆମ୍ଭେ ତୁମ୍ଭମାନଙ୍କ ପ୍ରତି ଯେଉଁ ସଙ୍କଳ୍ପ କରୁଅଛୁ, ତାହା ଆମ୍ଭେ ଜାଣୁ, ତାହା ଅମଙ୍ଗଳର ନୁହେଁ, ମାତ୍ର ମଙ୍ଗଳର ସଙ୍କଳ୍ପ।', 'or'),
  V('ଗୀତସଂହିତା ୨୩:୧', 'ସଦାପ୍ରଭୁ ମୋହର ପାଳକ, ମୋହର ଅଭାବ ହେବ ନାହିଁ।', 'or'),
  V('ରୋମୀୟ ୮:୩୭', 'ଯେ ଆମ୍ଭମାନଙ୍କୁ ପ୍ରେମ କଲେ, ତାହାଙ୍କ ଦ୍ୱାରା ଆମ୍ଭେମାନେ ଏହି ସମସ୍ତ ବିଷୟରେ ବିଜୟୀରୁ ଅଧିକ।', 'or'),
  V('କଲସୀୟ ୨:୧୫', 'ସେ ଆଧିପତ୍ୟ ଓ କର୍ତ୍ତୃତ୍ୱସବୁକୁ ନିରସ୍ତ୍ର କରି କ୍ରୁଶରେ ସେମାନଙ୍କ ଉପରେ ଜୟଯାତ୍ରା କଲେ।', 'or'),
  V('इफिसियों 1:4', 'जैसा उसने हमें जगत की उत्पत्ति से पहले उसमें चुन लिया, कि हम उसके निकट प्रेम में पवित्र और निर्दोष हों।', 'hi'),
  V('यूहन्ना 19:30', 'जब यीशु ने वह सिरका लिया, तो कहा, “पूरा हुआ”; और सिर झुकाकर प्राण त्याग दिए।', 'hi'),
  V('यशायाह 41:10', 'मत डर, क्योंकि मैं तेरे संग हूँ, इधर-उधर मत ताक, क्योंकि मैं तेरा परमेश्वर हूँ।', 'hi'),
  V('भजन संहिता 23:1', 'यहोवा मेरा चरवाहा है, मुझे कुछ घटी न होगी।', 'hi'),
  V('मत्ती 28:20', 'और देखो, मैं जगत के अन्त तक सदैव तुम्हारे संग हूँ।', 'hi'),
  V('रोमियों 8:37', 'परन्तु इन सब बातों में हम उसके द्वारा जिसने हम से प्रेम किया है, जयवन्त से भी बढ़कर हैं।', 'hi'),
  V('Ephesians 1:4', 'even as he chose us in him before the foundation of the world, that we would be holy and without defect before him in love;', 'en'),
  V('John 19:30', 'When Jesus therefore had received the vinegar, he said, “It is finished.” Then he bowed his head, and gave up his spirit.', 'en'),
  V('Jeremiah 29:11', '“For I know the thoughts that I think toward you,” says Yahweh, “thoughts of peace, and not of evil, to give you hope and a future.”', 'en'),
  V('Psalm 23:1', 'Yahweh is my shepherd; I shall lack nothing.', 'en'),
  V('Isaiah 41:10', 'Don’t you be afraid, for I am with you. Don’t be dismayed, for I am your God.', 'en'),
  V('Romans 8:37', 'No, in all these things, we are more than conquerors through him who loved us.', 'en')
]

/** ASR confusions the mock caption fixer flags (wrong → right). */
export const MOCK_FIXES: Record<string, { right: string; reason: string }> = {
  'କ୍ରୁସ': { right: 'କ୍ରୁଶ', reason: 'Bible vocabulary' },
  'ଜିସୁ': { right: 'ଯୀଶୁ', reason: 'Bible vocabulary' },
  'ପରମେସର': { right: 'ପରମେଶ୍ୱର', reason: 'learned correction' },
  'परमेसर': { right: 'परमेश्वर', reason: 'learned correction' },
  'यिशु': { right: 'यीशु', reason: 'Bible vocabulary' },
  'Jesús': { right: 'Jesus', reason: 'spelling' }
}

export const MOCK_SETTINGS: Settings = {
  data_dir: 'D:\\Viku',
  projects_dir: 'D:\\Viku\\projects',
  library_dir: 'D:\\Viku\\library',
  music_dir: 'D:\\Viku\\music',
  exports_dir: 'D:\\Viku\\exports',
  church_name: 'TAPP Church Hirakud',
  credit_line: 'Pastor Jacob Deep · TAPP Church Hirakud',
  default_language: 'or',
  export_presets: [
    { id: 'reels', name: 'Reels 1080×1920', width: 1080, height: 1920, fps: 30, max_seconds: 60 },
    { id: 'shorts', name: 'Shorts 1080×1920', width: 1080, height: 1920, fps: 30, max_seconds: 60 },
    { id: 'youtube', name: 'YouTube 16:9 1920×1080', width: 1920, height: 1080, fps: 30 }
  ]
}
