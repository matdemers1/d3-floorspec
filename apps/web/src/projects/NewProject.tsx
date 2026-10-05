import { type SyntheticEvent, useEffect, useState } from 'react';
import { Alert, Button, FormActions, FormField, Input, Modal, Stack } from '@d3cloud/ui';
import { api, messageOf } from '../lib/api';
import { navigate } from '../lib/router';
import { createFromDocument } from './fromDocument';
import type { Template } from './templates';

/**
 * A new, blank project: `POST /api/projects`, which stores the empty Floorspec document as version 0
 * with a `createProject` op as op 1. From a template, the template's document follows as op 2, a
 * batch of Floorspec Ops (fromDocument.ts).
 */
export function NewProject({ open, onOpenChange, template = null }: { open: boolean; onOpenChange: (open: boolean) => void; template?: Template | null }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setError(null);
      setBusy(false);
    } else {
      setName(template?.name ?? '');
    }
  }, [open, template]);

  const source = template?.document ?? null;

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const create: Promise<{ id: string }> =
      source === null
        ? api.post<{ id: string }>('/api/projects', { name })
        : createFromDocument(name, JSON.parse(source) as Record<string, unknown>).then((outcome) => {
            if (outcome.status === 'created') return { id: outcome.id };
            throw new Error(outcome.status === 'rejected' ? `The template was refused: ${outcome.diagnostics.map((d) => d.code).join(', ')}` : outcome.message);
          });
    create
      .then(({ id }) => {
        onOpenChange(false);
        setName('');
        navigate(`/projects/${id}`);
      })
      .catch((caught: unknown) => { setError(caught instanceof Error && !(caught.name === 'ApiError') ? caught.message : messageOf(caught)); })
      .finally(() => { setBusy(false); });
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={template === null || source === null ? 'New project' : `New project from ${template.name}`}
      description={source === null ? 'It starts as an empty Floorspec document, version 0.' : 'The template is applied as Floorspec Ops, so it is the first edit in the project’s history.'}
    >
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
