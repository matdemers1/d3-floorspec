import { useState } from 'react';
import { Download } from 'lucide-react';
import { ExportDialog } from './ExportDialog';
import type { DesignSet } from './api';

/** The editor top bar's Export (Figma 16 · Export): opens the Export dialog. */
export function ExportButton(props: { projectId: string; projectName: string; versionLabel: string | null; levels: readonly { id: string; name: string }[]; optionSets?: readonly DesignSet[] | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="fs-topbar__export" aria-haspopup="dialog" onClick={() => { setOpen(true); }}>
        <Download aria-hidden="true" />
        Export
      </button>
      <ExportDialog open={open} onOpenChange={setOpen} {...props} />
    </>
  );
}
