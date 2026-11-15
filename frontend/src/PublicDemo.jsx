import { useEffect, useState } from 'react'
import { BrainCircuit, Link2 } from 'lucide-react'
import { MeetingSummary } from './MeetingSummary.jsx'

const apiUrl = import.meta.env.VITE_DEMO_API_URL
const tokenKey = 'meeting-analyzer-demo-job'
const stageText = {
  downloading: 'Скачиваем видео…',
  validating: 'Проверяем видео…',
  extracting: 'Извлекаем аудио…',
  transcribing: 'Распознаём речь…',
  summarizing: 'Готовим конспект…',
}
const example = {
  summary: 'Команда согласовала обновление инструкции по запуску.',
  decisions: ['Обновить инструкцию по запуску.'],
  tasks: [{ description: 'Подготовить черновик инструкции', assignee: 'Анна', deadline: 'Пятница' }],
  open_questions: ['Где хранить итоговую инструкцию?'],
}

function Result({ transcript, summary }) {
  return (
    <>
      {summary && <MeetingSummary summary={summary} />}
      {typeof transcript === 'string' && (
        <section className="panel" aria-label="Расшифровка">
          <div className="panel-heading"><h2>Расшифровка</h2></div>
          <p className="transcript panel-body">{transcript.trim() || 'Речь не распознана.'}</p>
        </section>
      )}
    </>
  )
}

export function PublicDemo() {
  const [jobId, setJobId] = useState(() => sessionStorage.getItem(tokenKey))
  const [job, setJob] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const busy = submitting || Boolean(jobId && (!job || job.status === 'processing'))

  useEffect(() => {
    if (!jobId || !apiUrl) return
    const controller = new AbortController()
    let timer

    async function poll() {
      try {
        const response = await fetch(new URL('/api/demo/result', apiUrl), {
          headers: { Authorization: `Bearer ${jobId}` },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        })
        if (controller.signal.aborted) return
        if (response.status === 404) {
          sessionStorage.removeItem(tokenKey)
          setJobId(null)
          setJob(null)
          setMessage('Результат недоступен или срок хранения истёк.')
          return
        }
        if (!response.ok) throw new Error('Demo unavailable')
        const result = await response.json()
        if (controller.signal.aborted) return
        setJob(result)
        setMessage(result.error || (result.status === 'completed' ? 'Анализ готов.' : stageText[result.stage] || 'Обрабатываем запись…'))
        if (result.status !== 'processing') return
      } catch {
        if (!controller.signal.aborted) setMessage('Не удаётся связаться с сервером. Повторяем подключение…')
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1800)
    }

    poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [jobId])

  async function submit(event) {
    event.preventDefault()
    if (!apiUrl || busy) return
    setSubmitting(true)
    setMessage('Запускаем анализ…')
    const url = new FormData(event.currentTarget).get('url')
    try {
      const response = await fetch(new URL('/api/demo/jobs', apiUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(12_000),
      })
      const result = await response.json()
      if (response.status !== 202) {
        setMessage(result.error || 'Не удалось запустить демо-анализ.')
        return
      }
      sessionStorage.setItem(tokenKey, result.id)
      setJob(null)
      setJobId(result.id)
    } catch {
      setMessage('Сервер демо недоступен. Готовый пример можно открыть ниже.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon"><BrainCircuit size={23} aria-hidden="true" /></span>
          <span>AI Meeting Analyzer</span>
        </div>
        <span>Публичная демоверсия</span>
      </header>
      <main className="content demo-content">
        <div className="page-heading">
          <h1>Анализ записи встречи</h1>
          <p>Загрузите запись с Яндекс Диска и получите расшифровку и конспект.</p>
        </div>
        <section className="panel" aria-labelledby="demo-import">
          <div className="panel-heading">
            <h2 id="demo-import"><Link2 size={19} aria-hidden="true" /> Импорт с Яндекс Диска</h2>
          </div>
          <form className="panel-body import-form" onSubmit={submit}>
            <label htmlFor="demo-link">Публичная ссылка на видео</label>
            <div className="import-fields">
              <input id="demo-link" name="url" type="url" required maxLength={2048} disabled={!apiUrl || busy}
                placeholder="https://disk.yandex.ru/d/…" aria-describedby="demo-hint" />
              <button type="submit" className="upload-button" disabled={!apiUrl || busy}>Начать анализ</button>
            </div>
            <p id="demo-hint">MP4 или WebM до 5 минут и 100 МБ. Аудио и текст отправляются в OpenAI. Результат доступен в этой вкладке до часа.</p>
            <p className="upload-message" role="status">{message || (!apiUrl && 'Живой импорт пока недоступен.')}</p>
          </form>
        </section>
        {job && <Result transcript={job.transcript} summary={job.summary} />}
        <details className="panel demo-example">
          <summary>Пример результата на тестовой записи</summary>
          <Result
            transcript="Решили обновить инструкцию по запуску. Анна подготовит черновик к пятнице. Остался вопрос, где хранить итоговую инструкцию."
            summary={example}
          />
        </details>
      </main>
    </div>
  )
}
