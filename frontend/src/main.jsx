import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AudioLines, BrainCircuit, FileText, History, Link2, ListChecks, Plus, Sparkles, Trash2, Video } from 'lucide-react'
import '@fontsource/manrope/cyrillic-400.css'
import '@fontsource/manrope/cyrillic-700.css'
import '@fontsource/manrope/cyrillic-800.css'
import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-700.css'
import '@fontsource/manrope/latin-800.css'
import { MeetingSummary } from './MeetingSummary.jsx'
import { PublicDemo } from './PublicDemo.jsx'
import { meetingSourceLabels } from './meetingSources.js'
import './styles.css'

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001'
const statusLabels = { processing: 'Обрабатывается', completed: 'Готово', error: 'Ошибка' }
const stageLabels = {
  uploading: 'Загружаем видео…',
  downloading: 'Скачиваем видео с Яндекс Диска…',
  validating: 'Проверяем видео и ищем совпадения…',
  extracting: 'Извлекаем аудио',
  transcribing: 'Распознаём речь',
  summarizing: 'Готовим конспект',
}
const dateFormat = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' })

function statusLabel(meeting) {
  return (meeting.status === 'processing' && stageLabels[meeting.stage]) || statusLabels[meeting.status]
}

async function getJson(path, signal) {
  const response = await fetch(new URL(path, apiBaseUrl), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  })
  if (!response.ok) throw new Error('Could not load meeting data')
  return response.json()
}

function App() {
  const [connection, setConnection] = useState('Проверяем соединение…')
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState('')
  const [importMessage, setImportMessage] = useState('')
  const [meetings, setMeetings] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [meeting, setMeeting] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)
  const selectedMeeting = meeting?.id === selectedId ? meeting : null
  const busy = uploading || meetings.some(item => item.status === 'processing')

  useEffect(() => {
    const controller = new AbortController()
    let timer
    let loadedStatus
    let detailId

    async function refreshMeetings() {
      try {
        const items = await getJson('/api/meetings', controller.signal)
        if (controller.signal.aborted) return
        setMeetings(items)
        setConnection('Сервер доступен')

        const item = items.find(item => item.id === selectedId) ?? items[0]
        if (!item) {
          setMeeting(null)
          setSelectedId(null)
        } else if (item.id !== selectedId) {
          setSelectedId(item.id)
        } else if (item.id !== detailId || item.status !== loadedStatus || item.status === 'processing') {
          const detail = await getJson(`/api/meetings/${encodeURIComponent(item.id)}`, controller.signal)
          if (controller.signal.aborted) return
          detailId = detail.id
          loadedStatus = detail.status
          setMeeting(detail)
        }
      } catch {
        if (!controller.signal.aborted) setConnection('Не удалось обновить историю. Повторяем подключение…')
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refreshMeetings, 2000)
      }
    }

    refreshMeetings()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [selectedId])

  async function uploadVideo(event) {
    const input = event.currentTarget
    const file = input.files[0]
    if (!file) return

    const body = new FormData()
    body.append('video', file)
    try {
      await submitVideo('/api/meetings/upload', { body }, setUploadMessage, 'uploading')
    } finally {
      input.value = ''
    }
  }

  async function importVideo(event) {
    event.preventDefault()
    const form = event.currentTarget
    const url = new FormData(form).get('url')
    const accepted = await submitVideo('/api/meetings/import/yandex-disk', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }, setImportMessage, 'downloading')
    if (accepted) form.reset()
  }

  async function submitVideo(path, options, setMessage, initialStage) {
    setUploading(true)
    setMessage(stageLabels[initialStage])
    const polling = new AbortController()
    let timer
    async function refreshIntake() {
      try {
        const { stage } = await getJson('/api/meetings/intake', polling.signal)
        if (!polling.signal.aborted && stageLabels[stage]) setMessage(stageLabels[stage])
      } catch {
        // The submission itself reports connection failures.
      } finally {
        if (!polling.signal.aborted) timer = setTimeout(refreshIntake, 750)
      }
    }
    timer = setTimeout(refreshIntake, 750)
    try {
      const response = await fetch(new URL(path, apiBaseUrl), { method: 'POST', ...options })
      const result = await response.json()
      if (response.ok && typeof result.id === 'string') {
        setMessage(result.duplicate ? 'Эта запись уже есть в истории.' : 'Встреча добавлена в историю.')
        setSelectedId(result.id)
        return true
      } else {
        setMessage(result.error || 'Сервер вернул неполный результат обработки.')
      }
    } catch {
      setMessage('Не удалось связаться с сервером. Проверьте соединение и повторите попытку.')
    } finally {
      polling.abort()
      clearTimeout(timer)
      setUploading(false)
    }
    return false
  }

  async function deleteSelectedMeeting(id) {
    setDeleting(true)
    setDeleteError(null)
    try {
      const response = await fetch(new URL(`/api/meetings/${encodeURIComponent(id)}`, apiBaseUrl), {
        method: 'DELETE',
        signal: AbortSignal.timeout(15_000),
      })
      if (response.status !== 204 && response.status !== 404) {
        const result = await response.json()
        setDeleteError({ id, message: result.error || 'Не удалось удалить встречу.' })
        return
      }
      setMeetings(items => items.filter(item => item.id !== id))
      setMeeting(current => current?.id === id ? null : current)
      setSelectedId(current => current === id ? null : current)
      setConfirmDeleteId(null)
    } catch {
      setDeleteError({ id, message: 'Не удалось подтвердить удаление. Проверьте соединение и повторите попытку.' })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar" aria-labelledby="meetings-title">
        <div className="brand">
          <span className="brand-icon"><BrainCircuit size={23} aria-hidden="true" /></span>
          <span>AI Meeting Analyzer<small>ЛОКАЛЬНАЯ ВЕРСИЯ LIGHT</small></span>
        </div>
        <h2 id="meetings-title" className="eyebrow history-label">
          <History size={15} aria-hidden="true" /> История встреч
        </h2>
        {meetings.length ? (
          <ul className="meeting-list">
            {meetings.map(item => (
              <li key={item.id}>
                <button type="button" aria-pressed={item.id === selectedId} onClick={() => {
                  setConfirmDeleteId(null)
                  setDeleteError(null)
                  setSelectedId(item.id)
                }}>
                  <strong>{item.filename}</strong>
                  <span className="meeting-date">{dateFormat.format(new Date(item.createdAt))}</span>
                  <span className="meeting-date">{meetingSourceLabels[item.source]}</span>
                  <span className="status-pill" data-status={item.status}>{statusLabel(item)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="sidebar-empty">Записей пока нет.</p>}
      </aside>

      <div className="workspace">
        <header className="topbar">
          <span>Рабочее пространство <span aria-hidden="true">/</span> <strong>Встречи</strong></span>
          <p className="connection" role="status" data-online={connection === 'Сервер доступен'}>{connection}</p>
        </header>

        <main className="content">
          <div className="page-heading">
            <span className="eyebrow">Рабочее пространство Light</span>
            <h1>AI Meeting Analyzer</h1>
            <p>Расшифровки и конспекты ваших встреч.</p>
          </div>

          <section className="hero" aria-labelledby="upload-title">
            <div className="hero-body">
              <span className="eyebrow"><Sparkles size={15} aria-hidden="true" /> AI-анализ встреч</span>
              <h2 id="upload-title">Загрузите запись встречи.<br /><span className="gradient-text">Получите конспект и расшифровку.</span></h2>
              <p id="upload-hint">MP4 или WebM, до 30 минут и 750 МБ. Для анализа аудио и расшифровка отправляются в OpenAI.</p>
              <label className="upload-button" data-disabled={busy}>
                <Plus size={18} aria-hidden="true" /> Выбрать видео
                <input
                  type="file"
                  aria-label="Видеозапись встречи"
                  accept=".mp4,.webm"
                  aria-describedby="upload-hint"
                  disabled={busy}
                  onChange={uploadVideo}
                />
              </label>
              {uploadMessage && <p className="upload-message" role="status">{uploadMessage}</p>}
            </div>
            <div className="hero-art" aria-hidden="true">
              <div className="hero-orbit"><BrainCircuit size={78} strokeWidth={1.2} /></div>
              <span className="hero-note note-audio"><AudioLines size={16} /> Расшифровка</span>
              <span className="hero-note note-summary"><ListChecks size={16} /> Конспект встречи</span>
            </div>
          </section>

          <section className="panel" aria-labelledby="import-title">
            <div className="panel-heading">
              <h2 id="import-title"><Link2 size={19} aria-hidden="true" /> Импорт с Яндекс Диска</h2>
            </div>
            <form className="panel-body import-form" onSubmit={importVideo}>
              <label htmlFor="yandex-link">Публичная ссылка на видео</label>
              <div className="import-fields">
                <input id="yandex-link" name="url" type="url" required maxLength={2048} disabled={busy}
                  placeholder="https://disk.yandex.ru/d/…" aria-describedby="import-hint" />
                <button type="submit" className="upload-button" disabled={busy}>Импортировать</button>
              </div>
              <p id="import-hint">Один MP4 или WebM до 30 минут и 750 МБ. Скачивание по ссылке должно быть разрешено.</p>
              {importMessage && <p className="upload-message" role="status">{importMessage}</p>}
            </form>
          </section>

          {selectedMeeting && (
            <section className="panel meeting-detail" aria-labelledby="selected-title">
              <div className="panel-heading">
                <h2 id="selected-title"><Video size={19} aria-hidden="true" /> {selectedMeeting.filename}</h2>
                <div className="meeting-actions">
                  <span className="meeting-date">{meetingSourceLabels[selectedMeeting.source]}</span>
                  <p className="status-pill" data-status={selectedMeeting.status} role="status">{statusLabel(selectedMeeting)}</p>
                  {selectedMeeting.status !== 'processing' && confirmDeleteId !== selectedMeeting.id && (
                    <button className="delete-button" type="button" disabled={deleting} onClick={() => {
                      setDeleteError(null)
                      setConfirmDeleteId(selectedMeeting.id)
                    }}>
                      <Trash2 size={15} aria-hidden="true" /> Удалить встречу
                    </button>
                  )}
                </div>
              </div>
              {selectedMeeting.error && <p className="meeting-error" role="alert">{selectedMeeting.error}</p>}
              {confirmDeleteId === selectedMeeting.id && (
                <div className="panel-body">
                  <p>Встреча, расшифровка и конспект будут удалены из локальной истории.</p>
                  <div className="delete-confirm-actions">
                    <button className="cancel-button" type="button" disabled={deleting} onClick={() => {
                      setConfirmDeleteId(null)
                      setDeleteError(null)
                    }}>Отмена</button>
                    <button className="delete-button" type="button" disabled={deleting} onClick={() => deleteSelectedMeeting(selectedMeeting.id)}>
                      {deleting ? 'Удаляем…' : 'Подтвердить удаление'}
                    </button>
                  </div>
                </div>
              )}
              {deleteError?.id === selectedMeeting.id && <p className="meeting-error" role="alert">{deleteError.message}</p>}
            </section>
          )}
          {selectedMeeting?.summary && <MeetingSummary summary={selectedMeeting.summary} />}
          {typeof selectedMeeting?.transcript === 'string' && (
            <section className="panel" aria-labelledby="transcript-title">
              <div className="panel-heading">
                <h2 id="transcript-title"><FileText size={19} aria-hidden="true" /> Расшифровка</h2>
              </div>
              <p className="transcript panel-body">{selectedMeeting.transcript.trim() ? selectedMeeting.transcript : 'Речь не распознана.'}</p>
            </section>
          )}
          {meetings.length === 0 && (
            <section className="panel empty" aria-labelledby="empty-title">
              <span className="empty-icon"><Video size={24} aria-hidden="true" /></span>
              <h2 id="empty-title">Здесь появятся результаты встреч</h2>
              <p>Загрузите первую запись, чтобы получить расшифровку и конспект.</p>
            </section>
          )}
        </main>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(import.meta.env.VITE_PUBLIC_DEMO === 'true' ? <PublicDemo /> : <App />)
