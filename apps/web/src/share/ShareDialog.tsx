import './share.css';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Checkbox, FormField, Input, Modal, Select, SettingsRow, Switch, useToast } from '@d3cloud/ui';
import { Copy, Link2 } from 'lucide-react';
import { messageOf } from '../lib/api';
import { createShare, listShares, revokeShare, type NewShare, type ShareLinkRow } from './api';

/**
 * The share dialog (FLR-T-9.6; the board's "18 · Share settings"): make a read-only link — what it
 * shows, which version, how long it lasts, whether signed-in viewers may comment — copy it once, and
 * see and revoke the links already out there. A link's URL is shown here when it is made and never
 * again: the server keeps only its hash.
 */

const EXPIRIES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];

export const dateOf = (iso: string | Date) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function inDays(days: number): string {
  return dateOf(new Date(Date.now() + days * 86_400_000));
}

/** "Created Sep 30 · 14 views · 6 comments", or what stopped it. */
export function describeLink(link: ShareLinkRow): string {
  const parts = [`Created ${dateOf(link.createdAt)}`];
  if (link.state === 'revoked') parts.push(`revoked ${dateOf(link.revokedAt ?? link.createdAt)}`);
  else if (link.state === 'expired') parts.push(`expired ${dateOf(link.expiresAt)}`);
  else parts.push(`expires ${dateOf(link.expiresAt)}`);
  parts.push(`${String(link.views)} ${link.views === 1 ? 'view' : 'views'}`);
  if (link.comments) parts.push(`${String(link.commentCount)} ${link.commentCount === 1 ? 'comment' : 'comments'}`);
  return parts.join(' · ');
}

export function ShareDialog({
  projectId,
  projectName,
  versionLabel,
  open,
  onOpenChange,
  onChanged,
}: {
  projectId: string;
  projectName: string;
  /** "v42": the version main is at, for the version choice. */
  versionLabel: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Told when a link is made or revoked, so a card listing them can load again. */
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [links, setLinks] = useState<ShareLinkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState('30');
  const [version, setVersion] = useState<'latest' | 'current'>('latest');
  const [shows, setShows] = useState({ plan: true, threeD: true, findings: true });
  const [comments, setComments] = useState(true);

  const load = useCallback(() => {
    listShares(projectId).then(setLinks, (caught: unknown) => { setError(messageOf(caught)); });
  }, [projectId]);
  useEffect(() => {
    if (!open) return;
    setMade(null);
    setError(null);
    setConfirming(null);
    load();
  }, [open, load]);

  const nothingShown = !shows.plan && !shows.threeD && !shows.findings;
  const canComment = shows.plan || shows.threeD;

  const create = () => {
    const body: NewShare = { expiresInDays: Number(days), version, shows, comments: comments && canComment, ...(label.trim() === '' ? {} : { label: label.trim() }) };
    setBusy(true);
    setError(null);
    createShare(projectId, body)
      .then(({ url }) => {
        setMade(url);
        setLabel('');
        load();
        onChanged?.();
      })
      .catch((caught: unknown) => { setError(messageOf(caught)); })
      .finally(() => { setBusy(false); });
  };

  const revoke = (link: ShareLinkRow) => {
    if (confirming !== link.id) {
      setConfirming(link.id);
      return;
    }
    setConfirming(null);
    revokeShare(projectId, link.id)
      .then(() => {
        toast.show({ message: `${link.label ?? 'The link'} no longer works.` });
        load();
        onChanged?.();
      })
      .catch((caught: unknown) => { setError(messageOf(caught)); });
  };

  const copy = () => {
    if (made === null) return;
    navigator.clipboard.writeText(made).then(
      () => { toast.show({ message: 'Link copied. It is shown only now — keep it somewhere safe.' }); },
      () => { toast.show({ message: 'Copy did not work here: select the link and copy it.' }); },
    );
  };

  const active = (links ?? []).filter((l) => l.state === 'active');
  const ended = (links ?? []).filter((l) => l.state !== 'active').slice(0, 5);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Share ${projectName}`}
      description="Anyone with a link can view. Commenting needs an account."
      footer={
        <Button variant="primary" onClick={() => { onOpenChange(false); }}>
          Done
        </Button>
      }
    >
      <div className="fs-share-dialog">
        {error === null ? null : (
          <Alert tone="danger" title="That did not work" dynamic>
            {error}
          </Alert>
        )}
        {made !== null ? (
          <div className="fs-share-dialog__made">
            <div className="fs-share-dialog__url">
              <Input aria-label="The new link" readOnly value={made} onFocus={(e) => { e.currentTarget.select(); }} data-testid="share-url" />
              <Button variant="secondary" icon={<Copy />} onClick={copy}>
                Copy
              </Button>
            </div>
            <p className="fs-note">This is the only time the link is shown. Anyone who has it can view until it expires or you revoke it.</p>
            <Button variant="ghost" size="sm" onClick={() => { setMade(null); }}>
              Make another link
            </Button>
          </div>
        ) : (
          <div className="fs-share-dialog__form">
            <FormField label="Label" optional help="Only you see it: who the link is for.">
              <Input value={label} maxLength={80} placeholder="Architect review" onChange={(e) => { setLabel(e.target.value); }} />
            </FormField>
            <SettingsRow
              title="Shows"
              description={nothingShown ? 'Choose at least one.' : undefined}
              control={
                <div className="fs-share-dialog__shows" role="group" aria-label="What the link shows">
                  <Checkbox label="2D plan" checked={shows.plan} onCheckedChange={(v) => { setShows({ ...shows, plan: v === true }); }} />
                  <Checkbox label="3D" checked={shows.threeD} onCheckedChange={(v) => { setShows({ ...shows, threeD: v === true }); }} />
                  <Checkbox label="Findings" checked={shows.findings} onCheckedChange={(v) => { setShows({ ...shows, findings: v === true }); }} />
                </div>
              }
            />
            <SettingsRow
              title="Version"
              htmlFor
              control={(ids) => (
                <Select
                  id={ids.id}
                  value={version}
                  onValueChange={(v) => { setVersion(v === 'current' ? 'current' : 'latest'); }}
                  options={[
                    { value: 'latest', label: `Always latest accepted${versionLabel === null ? '' : ` (${versionLabel})`}` },
                    { value: 'current', label: `Only this version${versionLabel === null ? '' : ` (${versionLabel})`}` },
                  ]}
                />
              )}
            />
            <SettingsRow
              title="Expires"
              htmlFor
              control={(ids) => (
                <Select id={ids.id} value={days} onValueChange={setDays} options={EXPIRIES.map((e) => ({ value: e.value, label: `In ${e.label} · ${inDays(Number(e.value))}` }))} />
              )}
            />
            <SettingsRow
              title="Comments"
              description={canComment ? 'Signed-in viewers (app account or D3 Auth) can pin comments to the plan.' : 'Comments are pinned to the plan or the 3D view: show one of them.'}
              control={(ids) => <Switch aria-labelledby={ids.labelledBy} checked={comments && canComment} disabled={!canComment} onCheckedChange={setComments} />}
            />
            <div className="fs-share-dialog__create">
              <Button variant="primary" icon={<Link2 />} loading={busy} disabled={nothingShown} onClick={create}>
                Create link
              </Button>
            </div>
          </div>
        )}

        <section className="fs-share-dialog__links" aria-labelledby="fs-share-active">
          <h3 id="fs-share-active" className="fs-overline">
            Active links · {active.length}
          </h3>
          {links === null ? null : active.length === 0 ? (
            <p className="fs-note">No link is live. Nobody can see this project but you.</p>
          ) : (
            <ul className="fs-share-links">
              {active.map((link) => (
                <li key={link.id} className="fs-share-links__row">
                  <Link2 aria-hidden="true" />
                  <div className="fs-share-links__text">
                    <span className="fs-share-links__name">{link.label ?? `Link ${link.prefix}…`}</span>
                    <span className="fs-note">{describeLink(link)}</span>
                  </div>
                  <Button size="sm" variant="danger-ghost" onClick={() => { revoke(link); }} aria-label={confirming === link.id ? `Confirm: revoke ${link.label ?? 'this link'}` : `Revoke ${link.label ?? 'this link'}`}>
                    {confirming === link.id ? 'Revoke now' : 'Revoke'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {ended.length === 0 ? null : (
            <details className="fs-share-links__ended">
              <summary>Expired and revoked · {ended.length}</summary>
              <ul className="fs-share-links">
                {ended.map((link) => (
                  <li key={link.id} className="fs-share-links__row fs-share-links__row--ended">
                    <Link2 aria-hidden="true" />
                    <div className="fs-share-links__text">
                      <span className="fs-share-links__name">{link.label ?? `Link ${link.prefix}…`}</span>
                      <span className="fs-note">{describeLink(link)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      </div>
    </Modal>
  );
}
