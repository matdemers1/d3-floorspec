import { type SyntheticEvent, useEffect, useState } from 'react';
import { Alert, Button, FormActions, FormField, Input, Modal, Stack } from '@d3cloud/ui';
import { api, messageOf } from '../lib/api';
import { navigate } from '../lib/router';

/**
 * A new, blank project: `POST /api/projects`, which stores the empty Floorspec document as version 0
 * with a `createProject` op as op 1. Templates and imports start here too once they can be applied
 * as ops (see templates.ts).
 */
export function NewProject({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    api
      .post<{ id: string }>('/api/projects', { name })
      .then(({ id }) => {
        onOpenChange(false);
        setName('');
        navigate(`/projects/${id}`);
      })
      .catch((caught: unknown) => { setError(messageOf(caught)); })
      .finally(() => { setBusy(false); });
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="New project" description="It starts as an empty Floorspec document, version 0.">
      <form onSubmit={submit}>
        <Stack gap="16">
          {error === null ? null : (
            <Alert tone="danger" dynamic>
              {error}
            </Alert>
          )}
          <FormField label="Name">
            <Input name="name" autoFocus required maxLength={200} value={name} onChange={(e) => { setName(e.target.value); }} />
          </FormField>
          <FormActions>
            <Button type="button" variant="secondary" onClick={() => { onOpenChange(false); }}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Create project
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Modal>
  );
}
