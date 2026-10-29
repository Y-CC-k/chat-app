// AI 語音：透過 microsooft Edge「朗讀」神經語音 API 產生更自然的發音（不需金鑰）。
// 失敗時由前端退回瀏覽器內建 TTS。

import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import type { Readable } from 'node:stream'

export type TtsVoice = 'en' | 'zh'

const VOICE_NAMES: Record<TtsVoice, string> = {
  en: 'en-US-AvaNeural', // 自然美式女聲（老師感）
  zh: 'zh-TW-HsiaoChenNeural', // 台灣繁中
}

/** 每種語音一個連線，請求以序列方式排隊避免互相干擾 */
const connections = new Map<TtsVoice, MsEdgeTTS>()
const queues = new Map<TtsVoice, Promise<unknown>>()
const TEXT_LIMIT = 500
const SYNTH_TIMEOUT_MS = 15_000

function queue<T>(voice: TtsVoice, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(voice) ?? Promise.resolve()
  const next = previous.then(task, () => task())
  queues.set(voice, next)
  return next
}

async function synthesizeOnce(text: string, voice: TtsVoice): Promise<Buffer> {
  let tts = connections.get(voice)
  if (!tts) {
    tts = new MsEdgeTTS({ enableLogger: false, connectionTimeoutMs: 10_000 })
    await tts.setMetadata(VOICE_NAMES[voice], OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    connections.set(voice, tts)
  }
  const { audioStream }: { audioStream: Readable } = await tts.toStream(text, { rate: 0.95 })
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const timer = setTimeout(() => reject(new Error('tts synthesis timeout')), SYNTH_TIMEOUT_MS)
    audioStream.on('data', (chunk: Buffer) => chunks.push(chunk))
    audioStream.on('close', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    })
    audioStream.on('error', (error: unknown) => {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

/** 合成語音，失敗回傳 null（前端退回瀏覽器 TTS） */
export async function synthesize(text: string, voice: TtsVoice): Promise<Buffer | null> {
  const clean = text.replace(/[\r\n]+/g, '。').trim().slice(0, TEXT_LIMIT)
  if (!clean) return null
  return await queue(voice, async () => {
    try {
      return await synthesizeOnce(clean, voice)
    } catch (error) {
      // 連線可能壞掉，下次重建
      connections.delete(voice)
      console.error('[chat] TTS 合成失敗', error instanceof Error ? error.message : error)
      return null
    }
  })
}
