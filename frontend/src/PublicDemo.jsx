import { useEffect, useState } from 'react'
import { BrainCircuit, History, Link2, Trash2, Video } from 'lucide-react'
import { MeetingSummary } from './MeetingSummary.jsx'

const apiUrl = import.meta.env.VITE_DEMO_API_URL
const tokenKey = 'meeting-analyzer-demo-job'
const historyKey = 'meeting-analyzer-demo-history'
const dateFormat = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' })
const stageText = {
  downloading: 'Скачиваем видео…',
  validating: 'Проверяем видео…',
  extracting: 'Извлекаем аудио…',
  transcribing: 'Распознаём речь…',
  summarizing: 'Готовим конспект…',
}
const statusText = { processing: 'Обрабатывается', completed: 'Готово', error: 'Ошибка' }

function readHistory() {
  try {
    const entries = JSON.parse(sessionStorage.getItem(historyKey) || '[]')
    const previousId = sessionStorage.getItem(tokenKey)
    if (previousId && !entries.some(entry => entry.id === previousId)) {
      entries.unshift({ id: previousId, status: 'processing' })
    }
    return entries.filter(entry => !entry.expiresAt || Date.parse(entry.expiresAt) > Date.now())
  } catch {
    return []
  }
}

function meetingName(meeting) {
  return meeting.filename || 'Запись с Яндекс Диска'
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
  const [history, setHistory] = useState(readHistory)
  const [selection, setSelection] = useState(null)
  const [detail, setDetail] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [confirmationId, setConfirmationId] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const selected = history.find(entry => entry.id === selection) || history[0]
  const selectedId = selected?.id
  const activeId = history.find(entry => entry.status === 'processing')?.id
  const job = detail?.id === selectedId ? detail : null
  const confirming = Boolean(selectedId && confirmationId === selectedId)
  const busy = submitting || Boolean(activeId)

  useEffect(() => {
    sessionStorage.setItem(historyKey, JSON.stringify(history))
    sessionStorage.removeItem(tokenKey)
    const expirations = history.filter(entry => entry.expiresAt).map(entry => Date.parse(entry.expiresAt))
    if (!expirations.length) return
    const timer = setTimeout(() => {
      const now = Date.now()
      setHistory(entries => entries.filter(entry => !entry.expiresAt || Date.parse(entry.expiresAt) > now))
      setDetail(current => current?.expiresAt && Date.parse(current.expiresAt) <= now ? null : current)
    }, Math.max(0, Math.min(...expirations) - Date.now()))
    return () => clearTimeout(timer)
  }, [history])

  useEffect(() => {
    if ((!selectedId && !activeId) || !apiUrl) return
    const controller = new AbortController()
    let timer
    const ids = [...new Set([selectedId, activeId].filter(Boolean))]

    async function pollMeeting(id) {
      const response = await fetch(new URL('/api/demo/result', apiUrl), {
        headers: { Authorization: `Bearer ${id}` },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      })
      if (controller.signal.aborted) return
      if (response.status === 404) {
        setHistory(entries => entries.filter(entry => entry.id !== id))
        setDetail(current => current?.id === id ? null : current)
        if (id === selectedId) setMessage('Результат недоступен или срок хранения истёк.')
        return
      }
      if (!response.ok) throw new Error('Demo unavailable')
      const result = await response.json()
      if (controller.signal.aborted) return
      const { filename, createdAt, status, stage, expiresAt } = result
      setHistory(entries => entries.map(entry => entry.id === id
        ? { id, filename, createdAt: createdAt || entry.createdAt, status, stage, expiresAt }
        : entry))
      if (id === selectedId) setDetail({ ...result, id })
      return status === 'processing'
    }

    async function poll() {
      try {
        const statuses = await Promise.all(ids.map(pollMeeting))
        if (controller.signal.aborted) return
        setConnectionError('')
        if (!statuses.some(Boolean)) return
      } catch {
        if (!controller.signal.aborted) setConnectionError('Не удаётся связаться с сервером. Повторяем подключение…')
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1800)
    }

    poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [selectedId, activeId])

  async function submit(event) {
    event.preventDefault()
    if (!apiUrl || busy) return
    setSubmitting(true)
    setMessage('Проверяем ссылку…')
    const url = new FormData(event.currentTarget).get('url')
    try {
      const response = await fetch(new URL('/api/demo/jobs', apiUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, knownIds: history.map(entry => entry.id) }),
        signal: AbortSignal.timeout(12_000),
      })
      const result = await response.json()
      if (response.status === 200 && result.duplicate) {
        selectMeeting(result.id)
        setMessage('Эта запись уже есть в истории. Открыта существующая встреча.')
        return
      }
      if (response.status !== 202) {
        setMessage(result.error || 'Не удалось запустить демо-анализ.')
        return
      }
      setHistory(entries => [
        { id: result.id, createdAt: result.createdAt, status: 'processing', stage: 'downloading' },
        ...entries,
      ])
      selectMeeting(result.id)
      setMessage('')
    } catch {
      setMessage('Сервер демо недоступен. Готовый пример можно открыть ниже.')
    } finally {
      setSubmitting(false)
    }
  }

  function selectMeeting(id) {
    setSelection(id)
    setConfirmationId(null)
    setDeleteError('')
  }

  async function deleteMeeting(id) {
    setDeleting(true)
    setDeleteError('')
    try {
      const response = await fetch(new URL('/api/demo/result', apiUrl), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${id}` },
        signal: AbortSignal.timeout(12_000),
      })
      if (response.status !== 204 && response.status !== 404) {
        const { error } = await response.json()
        setDeleteError(error || 'Не удалось удалить встречу.')
        return
      }
      setHistory(entries => entries.filter(entry => entry.id !== id))
      setDetail(current => current?.id === id ? null : current)
      setConfirmationId(null)
      setMessage('Встреча удалена.')
    } catch {
      setDeleteError('Не удалось подтвердить удаление. Проверьте соединение и повторите попытку.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar" aria-labelledby="demo-history-title">
        <div className="brand">
          <span className="brand-icon"><BrainCircuit size={23} aria-hidden="true" /></span>
          <span>AI Meeting Analyzer<small>ПУБЛИЧНАЯ ДЕМОВЕРСИЯ</small></span>
        </div>
        <h2 id="demo-history-title" className="eyebrow history-label">
          <History size={15} aria-hidden="true" /> История встреч
        </h2>
        {history.length ? (
          <ul className="meeting-list">
            {history.map(entry => (
              <li key={entry.id}>
                <button type="button" aria-pressed={entry.id === selectedId} onClick={() => selectMeeting(entry.id)}>
                  <strong>{meetingName(entry)}</strong>
                  {entry.createdAt && <span className="meeting-date">{dateFormat.format(new Date(entry.createdAt))}</span>}
                  <span className="status-pill" data-status={entry.status}>{statusText[entry.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="sidebar-empty">Записей пока нет.</p>}
      </aside>
      <div className="workspace">
        <header className="topbar"><span>Рабочее пространство / <strong>Встречи</strong></span></header>
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
            <p className="upload-message" role="status">{connectionError || message || (!apiUrl && 'Живой импорт пока недоступен.')}</p>
          </form>
        </section>
        {selected && (
          <section className="panel" aria-labelledby="demo-meeting-title" key={selectedId}>
            <div className="panel-heading">
              <h2 id="demo-meeting-title"><Video size={19} aria-hidden="true" /> {meetingName(selected)}</h2>
              <div className="meeting-actions">
                <p className="status-pill" data-status={selected.status} role="status">
                  {statusText[selected.status]}
                </p>
                {apiUrl && selected.status !== 'processing' && !confirming && (
                  <button className="delete-button" type="button" disabled={deleting} onClick={() => setConfirmationId(selectedId)}>
                    <Trash2 size={15} aria-hidden="true" /> Удалить встречу
                  </button>
                )}
              </div>
            </div>
            {selected.status === 'processing' && selected.stage && (
              <p className="panel-body" role="status">{stageText[selected.stage]}</p>
            )}
            {job?.error && <p className="meeting-error" role="alert">{job.error}</p>}
            {confirming && (
              <div className="panel-body">
                <p>Встреча, расшифровка и конспект будут удалены из истории демо.</p>
                <div className="delete-confirm-actions">
                  <button className="cancel-button" type="button" disabled={deleting} onClick={() => {
                    setConfirmationId(null)
                    setDeleteError('')
                  }}>Отмена</button>
                  <button className="delete-button" type="button" disabled={deleting} onClick={() => deleteMeeting(selectedId)}>
                    {deleting ? 'Удаляем…' : 'Подтвердить удаление'}
                  </button>
                </div>
              </div>
            )}
            {deleteError && <p className="meeting-error" role="alert">{deleteError}</p>}
          </section>
        )}
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
    </div>
  )
}
