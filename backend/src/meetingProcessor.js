import { access, rm } from 'node:fs/promises'
import { extractAudio, AudioExtractionError } from './audioExtractor.js'
import { updateMeeting } from './meetingRepository.js'
import { generateMeetingSummary, SummaryError } from './summaryService.js'
import { transcribeAudio, TranscriptionError } from './transcriptionService.js'

export async function removeMeetingFiles(videoPath, { keepVideo = false } = {}) {
  const paths = [videoPath + '.mp3']
  if (!keepVideo) paths.push(videoPath)
  const results = await Promise.allSettled(paths.map(path => rm(path, { force: true })))
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('Could not remove temporary meeting file:', result.reason.code)
    }
  }
}

export async function processMeeting(meetingId, videoPath) {
  const result = await analyzeMeeting(videoPath, changes => updateMeeting(meetingId, changes))
  await updateMeeting(meetingId, result)
}

export async function analyzeMeeting(videoPath, report, { maxDurationSeconds, keepVideo } = {}) {
  const audioPath = videoPath + '.mp3'
  let failure
  let summary = null

  try {
    await access(videoPath)
    const { isSilent } = await extractAudio(videoPath, audioPath, { maxDurationSeconds })
    if (!isSilent) await report({ stage: 'transcribing' })
    const transcript = isSilent ? '' : await transcribeAudio(audioPath)
    await report({ transcript, stage: transcript.trim() ? 'summarizing' : null })
    summary = await generateMeetingSummary(transcript)
  } catch (error) {
    if (error instanceof AudioExtractionError || error instanceof TranscriptionError || error instanceof SummaryError) {
      failure = error.message
    } else {
      console.error('Meeting processing failed:', error.code ?? error.name)
      failure = 'Не удалось обработать запись.'
    }
  } finally {
    await removeMeetingFiles(videoPath, { keepVideo })
  }

  return {
    status: failure ? 'error' : 'completed',
    stage: null,
    summary,
    error: failure ?? null,
  }
}
