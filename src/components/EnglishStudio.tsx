// 英文教室翻譯工作台：介面模式取自 chinese-translator
// 方向切換（中文 ↔ English）、語音輸入、雙面板、朗讀語音選擇、語速調整
import { useEffect, useRef, useState } from 'react'
import { translate, type Direction } from '../utils/translator'
import {
  isSpeechSupported,
  speakText,
  stopSpeaking,
  subscribeVoices,
  voiceDisplayName,
  voiceGenderIcon,
  type VoiceSet,
} from '../utils/speechVoices'
import { isSpeechInputSupported, startListening, type ListenHandle } from '../utils/speechInput'

const OUTPUT_LANG: Record<Direction, 'en' | 'zh'> = { zh2en: 'en', en2zh: 'zh' }
const OUTPUT_TTS_LANG: Record<Direction, 'en-US' | 'zh-TW'> = { zh2en: 'en-US', en2zh: 'zh-TW' }
const REC_LANG: Record<Direction, string> = { zh2en: 'zh-TW', en2zh: 'en-US' }
const SRC_LABEL: Record<Direction, string> = { zh2en: '中文', en2zh: 'English' }
const OUT_LABEL: Record<Direction, string> = { zh2en: 'English', en2zh: '中文' }
const INPUT_PLACEHOLDER: Record<Direction, string> = {
  zh2en: '在此輸入要翻譯的中文…（Ctrl + Enter 快速翻譯）',
  en2zh: 'Type English text here… (Ctrl + Enter to translate)',
}
const VOICE_PREF_KEY = { en: 'tts-voice-uri-en', zh: 'tts-voice-uri-zh' }

export function EnglishStudio() {
  const [dir, setDir] = useState<Direction>('zh2en')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [provider, setProvider] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [rate, setRate] = useState(1)
  const [voiceSet, setVoiceSet] = useState<VoiceSet>({ en: [], zh: [], all: [] })
  const [showAllVoices, setShowAllVoices] = useState(false)
  const [voiceURIs, setVoiceURIs] = useState<{ en: string; zh: string }>(() => ({
    en: localStorage.getItem(VOICE_PREF_KEY.en) ?? '',
    zh: localStorage.getItem(VOICE_PREF_KEY.zh) ?? '',
  }))
  const [listening, setListening] = useState(false)
  const speechSupported = isSpeechSupported()
  const inputSupported = isSpeechInputSupported()
  /** 遞增的朗讀序號：偵測過期的結束事件，防止舊事件把新朗讀狀態關掉 */
  const speakToken = useRef(0)
  const listenHandle = useRef<ListenHandle | null>(null)
  /** 收音前的文字基底，讓辨識結果接在已有內容後面 */
  const inputBase = useRef('')
  const outputLang = OUTPUT_LANG[dir]
  const selectableVoices =
    voiceSet[outputLang].length > 0 ? voiceSet[outputLang] : showAllVoices ? voiceSet.all : []
  const missingOutputVoices =
    speechSupported && voiceSet[outputLang].length === 0 && voiceSet.all.length > 0

  useEffect(() => {
    return () => {
      stopSpeaking()
      listenHandle.current?.stop()
    }
  }, [])

  // 語音清單是瀏覽器非同步載入，訂閱 voiceschanged 以保持最新
  useEffect(() => {
    const unsubscribe = subscribeVoices(setVoiceSet)
    return unsubscribe
  }, [])

  /** 用指定語速與語音朗讀目前輸出，並登記結束事件 */
  function startSpeaking(withRate: number, withVoiceURI: string = voiceURIs[outputLang]) {
    const token = ++speakToken.current
    speakText(output, {
      lang: OUTPUT_TTS_LANG[dir],
      rate: withRate,
      voice: voiceSet.all.find((v) => v.voiceURI === withVoiceURI) ?? null,
      onEnd: () => {
        if (speakToken.current === token) setSpeaking(false)
      },
    })
  }

  function handleSpeak() {
    if (!output) return
    if (speaking) {
      speakToken.current += 1
      stopSpeaking()
      setSpeaking(false)
      return
    }
    try {
      startSpeaking(rate)
      setSpeaking(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '朗讀失敗')
    }
  }

  /** 調整語速；朗讀中會立即用新語速重新開始 */
  function handleRateChange(value: number) {
    setRate(value)
    if (speaking) {
      try {
        startSpeaking(value)
      } catch (err) {
        setSpeaking(false)
        setError(err instanceof Error ? err.message : '朗讀失敗')
      }
    }
  }

  /** 切換語音；朗讀中會立即用新語音重新開始 */
  function handleVoiceChange(value: string) {
    setVoiceURIs((prev) => {
      const next = { ...prev, [outputLang]: value }
      localStorage.setItem(VOICE_PREF_KEY[outputLang], value)
      return next
    })
    if (speaking) {
      try {
        startSpeaking(rate, value)
      } catch (err) {
        setSpeaking(false)
        setError(err instanceof Error ? err.message : '朗讀失敗')
      }
    }
  }

  async function handleTranslate() {
    if (!input.trim() || loading) return
    setLoading(true)
    setError('')
    setCopied(false)
    stopSpeaking()
    setSpeaking(false)
    try {
      const result = await translate(input, dir)
      setOutput(result.text)
      setProvider(result.provider)
    } catch (err) {
      setOutput('')
      setProvider('')
      setError(err instanceof Error ? err.message : '翻譯失敗，請稍後再試')
    } finally {
      setLoading(false)
    }
  }

  function handleClear() {
    setInput('')
    setOutput('')
    setProvider('')
    setError('')
    setCopied(false)
    stopSpeaking()
    setSpeaking(false)
    listenHandle.current?.stop()
    setListening(false)
  }

  function handleDirChange(next: Direction) {
    if (next === dir) return
    setDir(next)
    setOutput('')
    setProvider('')
    setError('')
    setCopied(false)
    stopSpeaking()
    setSpeaking(false)
    listenHandle.current?.stop()
    setListening(false)
  }

  async function handleCopy() {
    if (!output) return
    try {
      await navigator.clipboard.writeText(output)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('無法存取剪貼簿')
    }
  }

  /** 語音輸入：辨識結果會接在輸入框現有文字之後 */
  function handleMicToggle() {
    if (listening) {
      listenHandle.current?.stop()
      listenHandle.current = null
      setListening(false)
      return
    }
    try {
      inputBase.current = input
      listenHandle.current = startListening({
        lang: REC_LANG[dir],
        onPartial: (text) => setInput(`${inputBase.current}${inputBase.current ? ' ' : ''}${text}`),
        onFinal: (text) => {
          inputBase.current = `${inputBase.current}${inputBase.current ? ' ' : ''}${text}`.trim()
        },
        onEnd: () => {
          listenHandle.current = null
          setListening(false)
        },
        onError: (message) => {
          listenHandle.current = null
          setListening(false)
          setError(message)
        },
      })
      setListening(true)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法啟動語音輸入')
    }
  }

  return (
    <div className="en-studio">
      <h2 className="es-title">🀄 中英雙向翻譯教室</h2>
      <p className="es-subtitle">中文 ↔ English，還能用說的輸入</p>

      <div className="es-direction">
        <button
          type="button"
          className={dir === 'zh2en' ? 'active' : ''}
          onClick={() => handleDirChange('zh2en')}
        >
          中文 → English
        </button>
        <button
          type="button"
          className={dir === 'en2zh' ? 'active' : ''}
          onClick={() => handleDirChange('en2zh')}
        >
          English → 中文
        </button>
      </div>

      <div className="es-panels">
        <section className="es-panel">
          <div className="es-panel-header">
            <span>{SRC_LABEL[dir]}</span>
            <span className="es-char-count">
              {inputSupported && (
                <button
                  type="button"
                  className={`es-mic ${listening ? 'listening' : ''}`}
                  onClick={handleMicToggle}
                  aria-label="語音輸入"
                >
                  {listening ? '🔊 收音中…' : '🎤 語音'}
                </button>
              )}
              {input.length} 字
            </span>
          </div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void handleTranslate()
              }
            }}
            placeholder={INPUT_PLACEHOLDER[dir]}
            rows={8}
          />
        </section>

        <section className="es-panel">
          <div className="es-panel-header">
            <span>{OUT_LABEL[dir]}</span>
            <div className="es-header-right">
              {provider && <span className="es-provider">來源：{provider}</span>}
              {speechSupported && selectableVoices.length > 0 && (
                <select
                  className="es-voice-select"
                  value={voiceURIs[outputLang]}
                  aria-label="朗讀語音"
                  onChange={(e) => handleVoiceChange(e.target.value)}
                >
                  <option value="">🎧 系統預設</option>
                  {selectableVoices.map((v) => (
                    <option key={v.voiceURI} value={v.voiceURI}>
                      {voiceGenderIcon(v)}
                      {voiceDisplayName(v)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
          <textarea
            value={output}
            readOnly
            placeholder="翻譯結果會顯示在這裡…"
            rows={8}
          />
        </section>
      </div>

      <div className="es-actions">
        <button
          type="button"
          className="es-btn primary"
          onClick={() => void handleTranslate()}
          disabled={loading || !input.trim()}
        >
          {loading ? '翻譯中…' : '翻譯'}
        </button>
        <button type="button" className="es-btn" onClick={handleClear} disabled={loading}>
          清空
        </button>
        <button
          type="button"
          className="es-btn"
          onClick={() => void handleCopy()}
          disabled={!output}
        >
          {copied ? '✅ 已複製' : '複製結果'}
        </button>
        {speechSupported && (
          <button type="button" className="es-btn" onClick={handleSpeak} disabled={!output}>
            {speaking ? '⏹ 停止朗讀' : '🔊 朗讀'}
          </button>
        )}
        {speechSupported && (
          <label className="es-rate">
            🐢
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.1}
              value={rate}
              aria-label="朗讀語速"
              onChange={(e) => handleRateChange(Number(e.target.value))}
            />
            🐇
            <span className="es-rate-value">{rate.toFixed(1)}x</span>
          </label>
        )}
        {missingOutputVoices && (
          <div className="es-hint">
            <span>
              ⚠️ 此裝置沒有 {OUT_LABEL[dir]}語音，朗讀效果可能不佳。
              {outputLang === 'en' && (
                <>
                  改用 <b>Microsoft Edge</b> 開啟可直接使用線上自然男女聲，不需安裝。
                </>
              )}
            </span>
            {!showAllVoices && (
              <button type="button" className="es-linklike" onClick={() => setShowAllVoices(true)}>
                改用其他語音
              </button>
            )}
          </div>
        )}
      </div>

      {error && <p className="es-error">⚠️ {error}</p>}
    </div>
  )
}
