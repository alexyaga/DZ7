import { access, rm } from 'node:fs/promises'
import { extractAudio, AudioExtractionError } from './audioExtractor.js'
import { updateMeeting } from './meetingRepository.js'
import { generateMeetingSummary, SummaryError } from './summaryService.js'
import { transcribeAudio, TranscriptionError } from './transcriptionService.js'

export async function removeMeetingFiles(videoPath) {
  const results = await Promise.allSettled([
    rm(videoPath, { force: true }),
    rm(videoPath + '.mp3', { force: true }),
  ])
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('Could not remove temporary meeting file:', result.reason.code)
    }
  }
}

export async function processMeeting(meetingId, videoPath) {
  const audioPath = videoPath + '.mp3'
  let failure
  let summary = null

  try {
    await access(videoPath)
    const { isSilent } = await extractAudio(videoPath, audioPath)
    if (!isSilent) await updateMeeting(meetingId, { stage: 'transcribing' })
    const transcript = isSilent ? '' : await transcribeAudio(audioPath)
    await updateMeeting(meetingId, { transcript, stage: transcript.trim() ? 'summarizing' : null })
    summary = await generateMeetingSummary(transcript)
  } catch (error) {
    if (error instanceof AudioExtractionError || error instanceof TranscriptionError || error instanceof SummaryError) {
      failure = error.message
    } else {
      console.error('Meeting processing failed:', error.code ?? error.name)
      failure = 'Не удалось обработать запись.'
    }
  } finally {
    await removeMeetingFiles(videoPath)
  }

  await updateMeeting(meetingId, {
    status: failure ? 'error' : 'completed',
    stage: null,
    summary,
    error: failure ?? null,
  })
}
