import { useEffect, useState } from 'react'
import { BrainCircuit, History, Link2, Trash2, Upload, Video } from 'lucide-react'
import { MeetingSummary } from './MeetingSummary.jsx'
import { meetingSourceLabels } from './meetingSources.js'

const apiUrl = import.meta.env.VITE_DEMO_API_URL
const maxUploadBytes = 100_000_000
const deleteKeysStorage = 'meeting-analyzer-demo-delete-keys'
const dateFormat = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' })
const stageText = {
  downloading: 'Скачиваем видео…',
  validating: 'Проверяем видео…',
  extracting: 'Извлекаем аудио…',
  transcribing: 'Распознаём речь…',
  summarizing: 'Готовим конспект…',
}
const statusText = { processing: 'Обрабатывается', completed: 'Готово', error: 'Ошибка' }

function readDeleteKeys() {
  try {
    const keys = JSON.parse(localStorage.getItem(deleteKeysStorage) ?? '{}')
    return Object.fromEntries(Object.entries(keys).filter(([, key]) => Date.parse(key?.expiresAt) > Date.now()))
  } catch {
    return {}
  }
}

function meetingName(meeting) {
  return meeting.filename || (meeting.source === 'manual' ? 'Локальная запись' : 'Запись с Яндекс Диска')
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
  const [history, setHistory] = useState([])
  const [deleteKeys, setDeleteKeys] = useState(readDeleteKeys)
  const [selection, setSelection] = useState(() => new URLSearchParams(location.search).get('meeting'))
  const [detail, setDetail] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [confirmationId, setConfirmationId] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const selected = selection ? history.find(entry => entry.id === selection) : history[0]
  const selectedId = selected?.id
  const deleteToken = deleteKeys[selectedId]?.token
  const job = detail?.id === selectedId ? detail : null
  const confirming = Boolean(selectedId && confirmationId === selectedId)
  const busy = submitting || history.some(entry => entry.status === 'processing')

  useEffect(() => {
    try {
      localStorage.setItem(deleteKeysStorage, JSON.stringify(deleteKeys))
    } catch {
      // The current page can still delete its uploads when browser storage is unavailable.
    }
  }, [deleteKeys])

  useEffect(() => {
    if (!apiUrl) return
    const controller = new AbortController()
    let timer

    async function poll() {
      try {
        const response = await fetch(new URL('/api/demo/jobs', apiUrl), {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        })
        if (!response.ok) throw new Error('Demo unavailable')
        const entries = await response.json()
        if (controller.signal.aborted) return
        setHistory(entries)
        setConnectionError('')
      } catch {
        if (!controller.signal.aborted) setConnectionError('Не удаётся связаться с сервером. Повторяем подключение…')
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 4000)
    }

    poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (!apiUrl || !selectedId) return
    const controller = new AbortController()
    let timer

    async function poll() {
      try {
        const response = await fetch(new URL(`/api/demo/jobs/${selectedId}`, apiUrl), {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        })
        if (response.status === 404) return
        if (!response.ok) throw new Error('Demo unavailable')
        const result = await response.json()
        if (controller.signal.aborted) return
        setDetail(result)
        if (result.status !== 'processing') return
      } catch {
        if (controller.signal.aborted) return
      }
      timer = setTimeout(poll, 1800)
    }

    poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [selectedId])

  async function submit(event, source) {
    event.preventDefault()
    if (!apiUrl || busy) return
    const form = event.currentTarget
    const formData = new FormData(form)
    const isUpload = source === 'manual'
    const file = isUpload ? formData.get('video') : null
    if (isUpload && (!file?.size || file.size > maxUploadBytes)) {
      setMessage(file?.size ? 'Размер видео превышает 100 МБ.' : 'Выберите непустой видеофайл.')
      return
    }

    setSubmitting(true)
    setMessage(isUpload ? 'Загружаем видео с компьютера…' : 'Проверяем ссылку…')
    try {
      const response = await fetch(new URL(isUpload ? '/api/demo/jobs/upload' : '/api/demo/jobs', apiUrl), {
        method: 'POST',
        headers: isUpload ? undefined : { 'Content-Type': 'application/json' },
        body: isUpload ? formData : JSON.stringify({ url: formData.get('url') }),
        signal: AbortSignal.timeout(isUpload ? 300_000 : 12_000),
      })
      if (isUpload && response.status === 413) {
        setMessage('Сервер отклонил загрузку из-за размера. Выберите файл меньшего размера.')
        return
      }
      const result = await response.json()
      if (response.status === 200 && result.duplicate) {
        setHistory(entries => entries.some(entry => entry.id === result.id) ? entries : [...entries, result])
        selectMeeting(result.id)
        setMessage('Эта запись уже есть в истории. Открыта существующая встреча.')
        return
      }
      if (response.status !== 202) {
        setMessage(result.error || 'Не удалось запустить демо-анализ.')
        return
      }
      const { deleteToken, ...meeting } = result
      setDeleteKeys(keys => ({ ...keys, [meeting.id]: { token: deleteToken, expiresAt: meeting.expiresAt } }))
      setHistory(entries => entries.some(entry => entry.id === meeting.id) ? entries : [meeting, ...entries])
      if (isUpload) form.reset()
      selectMeeting(result.id)
      setMessage('')
    } catch (error) {
      setMessage(isUpload && error.name === 'TimeoutError'
        ? 'Загрузка заняла слишком много времени. Попробуйте загрузить файл меньшего размера.'
        : 'Сервер демо недоступен. Готовый пример можно открыть ниже.')
    } finally {
      setSubmitting(false)
    }
  }

  function selectMeeting(id) {
    const url = new URL(location.href)
    if (id) url.searchParams.set('meeting', id)
    else url.searchParams.delete('meeting')
    window.history.replaceState(null, '', url)
    setSelection(id)
    setConfirmationId(null)
    setDeleteError('')
  }

  async function deleteMeeting(id) {
    setDeleting(true)
    setDeleteError('')
    try {
      const response = await fetch(new URL(`/api/demo/jobs/${id}`, apiUrl), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${deleteToken}` },
        signal: AbortSignal.timeout(12_000),
      })
      if (response.status !== 204 && response.status !== 404) {
        const { error } = await response.json()
        setDeleteError(error || 'Не удалось удалить встречу.')
        return
      }
      setHistory(entries => entries.filter(entry => entry.id !== id))
      setDeleteKeys(keys => Object.fromEntries(Object.entries(keys).filter(([key]) => key !== id)))
      setDetail(current => current?.id === id ? null : current)
      selectMeeting(null)
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
          <History size={15} aria-hidden="true" /> Общая история встреч
        </h2>
        {history.length ? (
          <ul className="meeting-list">
            {history.map(entry => (
              <li key={entry.id}>
                <button type="button" aria-pressed={entry.id === selectedId} onClick={() => selectMeeting(entry.id)}>
                  <strong>{meetingName(entry)}</strong>
                  {entry.createdAt && <span className="meeting-date">{dateFormat.format(new Date(entry.createdAt))}</span>}
                  <span className="meeting-date">{meetingSourceLabels[entry.source]}</span>
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
          <p>Загрузите видео с компьютера или Яндекс Диска и получите расшифровку и конспект.</p>
        </div>
        <section className="panel" aria-labelledby="demo-import">
          <div className="panel-heading">
            <h2 id="demo-import"><Video size={19} aria-hidden="true" /> Загрузка записи</h2>
          </div>
          <div className="panel-body demo-intake">
            <form className="import-form" onSubmit={event => submit(event, 'yandex_disk')}>
              <label htmlFor="demo-link"><Link2 size={15} aria-hidden="true" /> Публичная ссылка на Яндекс Диск</label>
              <div className="import-fields">
                <input id="demo-link" name="url" type="url" required maxLength={2048} disabled={!apiUrl || busy}
                  placeholder="https://disk.yandex.ru/d/…" aria-describedby="demo-hint" />
                <button type="submit" className="upload-button" disabled={!apiUrl || busy}>Импортировать</button>
              </div>
            </form>
            <form className="import-form" onSubmit={event => submit(event, 'manual')}>
              <label htmlFor="demo-file"><Upload size={15} aria-hidden="true" /> Видео с компьютера</label>
              <div className="import-fields">
                <input id="demo-file" name="video" type="file" required accept=".mp4,.webm" disabled={!apiUrl || busy}
                  aria-describedby="demo-hint" />
                <button type="submit" className="upload-button" disabled={!apiUrl || busy}>Загрузить файл</button>
              </div>
            </form>
            <p id="demo-hint">MP4 или WebM до 5 минут и 100 МБ. Видео, расшифровка и конспект будут видны всем посетителям демо семь дней. Аудио и текст отправляются в OpenAI.</p>
            <p className="upload-message" role="status">{connectionError || message || (!apiUrl && 'Загрузка пока недоступна.')}</p>
          </div>
        </section>
        {selected && (
          <section className="panel" aria-labelledby="demo-meeting-title" key={selectedId}>
            <div className="panel-heading">
              <h2 id="demo-meeting-title"><Video size={19} aria-hidden="true" /> {meetingName(selected)}</h2>
              <div className="meeting-actions">
                <span className="meeting-date">{meetingSourceLabels[selected.source]}</span>
                <p className="status-pill" data-status={selected.status} role="status">
                  {statusText[selected.status]}
                </p>
                {deleteToken && selected.status !== 'processing' && !confirming && (
                  <button className="delete-button" type="button" disabled={deleting} onClick={() => setConfirmationId(selectedId)}>
                    <Trash2 size={15} aria-hidden="true" /> Удалить встречу
                  </button>
                )}
              </div>
            </div>
            {selected.status === 'processing' && selected.stage && (
              <p className="panel-body" role="status">{stageText[selected.stage]}</p>
            )}
            {selected.videoFormat && (
              <div className="panel-body">
                <video className="demo-video" controls preload="metadata" aria-label="Видео встречи"
                  src={new URL(`/api/demo/jobs/${selectedId}/video`, apiUrl).href} />
              </div>
            )}
            {job?.error && <p className="meeting-error" role="alert">{job.error}</p>}
            {confirming && (
              <div className="panel-body">
                <p>Видео, расшифровка и конспект будут удалены из общей истории.</p>
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
