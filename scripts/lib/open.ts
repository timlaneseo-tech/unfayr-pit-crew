/** Command and args that open a file with the OS default app. Node quotes each arg itself, so a spaced path stays one argument. */
export function openCommand(file: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', file] };
  if (platform === 'darwin') return { cmd: 'open', args: [file] };
  return { cmd: 'xdg-open', args: [file] };
}
