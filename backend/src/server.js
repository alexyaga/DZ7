import { once } from 'node:events'
import cors from 'cors'
import express from 'express'
import { deleteMeeting, getMeeting, initializeMeetings, listMeetings } from './meetingRepository.js'
import { getIntakeStage, handleVideoUpload, handleYandexImport, prepareUploadDirectory } from './videoUpload.js'

const port = Number(process.env.PORT ?? 3001)
const clientOrigin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173'
const app = express()
let ready = false

app.disable('x-powered-by')
app.use(cors({ origin: clientOrigin }))
app.use('/api', (_request, response, next) => {
  response.set('Cache-Control', 'no-store')
  if (!ready) return response.status(503).json({ error: 'Сервер загружает историю встреч.' })
  return next()
})
app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok' })
})
function allowVideoIntake(request, response, next) {
  const origin = request.get('Origin')
  if (origin && origin !== clientOrigin) {
    return response.status(403).json({ error: 'Загрузка с этого адреса запрещена.' })
  }
  return next()
}
app.post('/api/meetings/upload', allowVideoIntake, handleVideoUpload)
app.post('/api/meetings/import/yandex-disk', allowVideoIntake, express.json({ limit: '4kb' }), handleYandexImport)
app.use('/api/meetings/import/yandex-disk', (error, _request, response, next) => {
  if (error.type === 'entity.too.large') {
    return response.status(413).json({ error: 'Ссылка слишком длинная.' })
  }
  if (error.type === 'entity.parse.failed') {
    return response.status(400).json({ error: 'Передайте ссылку в поле url.' })
  }
  return next(error)
})

app.get('/api/meetings', (_request, response) => {
  response.json(listMeetings())
})
app.get('/api/meetings/intake', (_request, response) => {
  response.json({ stage: getIntakeStage() })
})
app.get('/api/meetings/:id', (request, response) => {
  const meeting = getMeeting(request.params.id)
  if (!meeting) return response.status(404).json({ error: 'Встреча не найдена.' })
  return response.json(meeting)
})

app.delete('/api/meetings/:id', async (request, response) => {
  const origin = request.get('Origin')
  if (origin && origin !== clientOrigin) {
    return response.status(403).json({ error: 'Удаление с этого адреса запрещено.' })
  }

  const { id } = request.params
  try {
    if (await deleteMeeting(id)) return response.status(204).end()
    if (!getMeeting(id)) return response.status(404).json({ error: 'Встреча не найдена.' })
    return response.status(409).json({ error: 'Дождитесь завершения обработки встречи.' })
  } catch (error) {
    console.error('Could not delete meeting:', error.code ?? error.name)
    return response.status(500).json({ error: 'Не удалось сохранить изменения в истории встреч.' })
  }
})

const server = app.listen(port, 'localhost')
await once(server, 'listening')
await initializeMeetings()
await prepareUploadDirectory()
ready = true
console.log(`Backend: http://localhost:${server.address().port}`)
