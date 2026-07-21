let synth: SpeechSynthesis | null = null

function getSynth(): SpeechSynthesis | null {
  if (typeof window === 'undefined') return null
  if (!synth) synth = window.speechSynthesis
  return synth
}

export function speakCue(text: string) {
  const s = getSynth()
  if (!s) return

  // Cancel current speech before new cue
  s.cancel()

  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = 0.95
  utterance.pitch = 1
  utterance.volume = 1

  // Prefer a local voice to avoid network dependency
  const voices = s.getVoices()
  const preferred = voices.find(v => v.lang.startsWith('en') && v.localService)
  if (preferred) utterance.voice = preferred

  s.speak(utterance)
}

export function cancelSpeech() {
  getSynth()?.cancel()
}
