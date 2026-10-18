import { useMC } from '../../lib/store.js';
import { ModelPick, Notifications, RestartOffer, StartStop } from '../mia/Controls.jsx';

// Mia's switches (task 0290): moved here from the chat header so the chat is
// just the chat. Same Section/Row as the rest of Settings (passed in, like
// AnnounceSection).
export default function MiaSection({ Section, Row }) {
  const mia = useMC((s) => s.mia);
  const push = useMC((s) => s.push);
  if (!mia) return null;
  return (
    <Section title="Mia">
      <div data-settings-mia>
        <Row label="Model" hint="What Mia runs on. A change applies from her next start.">
          <ModelPick mia={mia} />
        </Row>
        <RestartOffer mia={mia} />
        {push !== 'unsupported' && (
          <Row label="Notifications" hint="Mia’s updates and questions as notifications on this device.">
            <div className="flex items-center gap-1.5">
              <Notifications />
            </div>
          </Row>
        )}
        <Row label="Mia" hint={mia.enabled ? 'Stopping ends her session; tasks and messages wait until she starts again.' : 'Mia is off.'} last>
          <StartStop mia={mia} />
        </Row>
      </div>
    </Section>
  );
}
