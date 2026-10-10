import { useState, useEffect, useCallback } from 'react';
import { soundService, type SoundCue } from '../ui/soundManager';

export function useSound() {
  const [isMuted, setIsMutedState] = useState<boolean>(() => soundService.isMuted());

  useEffect(() => {
    const handleMuteChange = (e: Event) => {
      const customEvent = e as CustomEvent<{ muted: boolean }>;
      if (customEvent.detail && typeof customEvent.detail.muted === 'boolean') {
        setIsMutedState(customEvent.detail.muted);
      } else {
        setIsMutedState(soundService.isMuted());
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('tala-mute-change', handleMuteChange);
      return () => {
        window.removeEventListener('tala-mute-change', handleMuteChange);
      };
    }
  }, []);

  const play = useCallback((cue: SoundCue) => {
    soundService.play(cue);
  }, []);

  const setMuted = useCallback((val: boolean) => {
    soundService.setMuted(val);
    setIsMutedState(val);
  }, []);

  const toggleMute = useCallback(() => {
    const next = soundService.toggleMute();
    setIsMutedState(next);
    return next;
  }, []);

  return {
    play,
    playSuccess: useCallback(() => soundService.play('success'), []),
    playError: useCallback(() => soundService.play('error'), []),
    playDelete: useCallback(() => soundService.play('delete'), []),
    playDialogOpen: useCallback(() => soundService.play('dialog_open'), []),
    playDialogClose: useCallback(() => soundService.play('dialog_close'), []),
    isMuted,
    setMuted,
    toggleMute,
  };
}
