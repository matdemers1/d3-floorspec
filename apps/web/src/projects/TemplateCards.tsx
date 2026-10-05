import { useMemo } from 'react';
import { Badge, Card } from '@d3cloud/ui';
import { FilePlus } from 'lucide-react';
import { PlanThumbnail } from '../components/PlanThumbnail';
import { describeModel, summarize, type ModelSummary } from './model';
import { TEMPLATES, TEMPLATES_LOADABLE, type Template } from './templates';

/**
 * "Start from a template". Blank works today; a template with a house in it is offered once it can
 * be applied as ops (templates.ts), and until then its card says when, in visible text rather than
 * a tooltip on something that cannot be focused. Each card shows the plan of the template's lowest
 * level, drawn from what the engine derived, what the house is, and the engine's numbers.
 */
interface Props {
  onBlank: () => void;
  /** Creates a project from a template. Unset until templates can be applied as ops. */
  onTemplate?: ((template: Template) => void) | undefined;
}

export function Templates({ onBlank, onTemplate }: Props) {
  return (
    <section className="fs-templates" aria-labelledby="fs-templates-heading">
      <h2 id="fs-templates-heading" className="fs-heading-14">
        Start from a template
      </h2>
      <ul className="fs-template-grid">
        {TEMPLATES.map((template) => (
          <li key={template.id}>
            <TemplateCard template={template} onBlank={onBlank} onTemplate={TEMPLATES_LOADABLE ? onTemplate : undefined} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function TemplateCard({ template, onBlank, onTemplate }: { template: Template } & Props) {
  // Derived once from the bundled document: the plan and the numbers on the card are the engine's.
  const summary = useMemo(() => (template.document === null ? null : summarize(template.document)), [template]);

  if (summary === null) {
    return (
      <Card interactive onClick={onBlank} className="fs-template-card">
        <Well summary={null} />
        <span className="fs-template-card__title">{template.name}</span>
        <span className="fs-card-text">{template.blurb}</span>
      </Card>
    );
  }
  const meta = describeModel(summary);
  if (onTemplate !== undefined) {
    return (
      <Card interactive onClick={() => { onTemplate(template); }} className="fs-template-card">
        <Well summary={summary} />
        <span className="fs-template-card__title">{template.name}</span>
        <span className="fs-card-text">{template.blurb}</span>
        <span className="fs-caption">{meta}</span>
      </Card>
    );
  }
  return (
    <Card className="fs-template-card" data-unavailable="true">
      <Well summary={summary} />
      <span className="fs-template-card__title">
        {template.name}
        <Badge tone="neutral" size="sm">
          With the editor
        </Badge>
      </span>
      <span className="fs-card-text">{meta}</span>
      <span className="fs-caption">Templates load as Floorspec Ops, which arrive with the plan editor.</span>
    </Card>
  );
}

/** The template's plan, or for the blank project a note that there is nothing to draw. */
function Well({ summary }: { summary: ModelSummary | null }) {
  return (
    <div className="fs-plan-well fs-template-card__plan">
      {summary !== null && summary.document !== null && summary.derived !== null && !summary.empty ? (
        // Named for what it is: the card's own title names the template, once.
        <PlanThumbnail document={summary.document} derived={summary.derived} title="Floor plan" />
      ) : (
        <span className="fs-well-note">
          <FilePlus aria-hidden="true" />
          Empty
        </span>
      )}
    </div>
  );
}
