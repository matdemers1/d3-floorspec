import { useMemo } from 'react';
import { Badge, Card } from '@d3cloud/ui';
import { describeModel, summarize } from './model';
import { TEMPLATES, TEMPLATES_LOADABLE, type Template } from './templates';

/**
 * "Start from a template". Blank works today; a template with a house in it is offered once it can
 * be applied as ops (templates.ts), and until then its card says when, in visible text rather than
 * a tooltip on something that cannot be focused.
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
  // Derived once from the bundled canonical document: the numbers on the card are the engine's.
  const meta = useMemo(() => (template.document === null ? template.blurb : describeModel(summarize(template.document))), [template]);

  if (template.document === null) {
    return (
      <Card interactive onClick={onBlank} className="fs-template-card">
        <span className="fs-template-card__title">{template.name}</span>
        <span className="fs-card-text">{meta}</span>
      </Card>
    );
  }
  if (onTemplate !== undefined) {
    return (
      <Card interactive onClick={() => { onTemplate(template); }} className="fs-template-card">
        <span className="fs-template-card__title">{template.name}</span>
        <span className="fs-card-text">{meta}</span>
      </Card>
    );
  }
  return (
    <Card className="fs-template-card" data-unavailable="true">
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
