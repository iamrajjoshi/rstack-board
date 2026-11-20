// A child process for the concurrency tests: `writer.ts <db> post <name> <count>` posts threads,
// `writer.ts <db> claim <name> <channel>` tries to claim the oldest ready thread.
import { BoardError } from '../shared/errors';
import { Store } from '../shared/store';

const [file = '', mode, name = '', argument = ''] = process.argv.slice(2);
const store = new Store(file);

if (mode === 'post') {
  for (let index = 0; index < Number(argument); index += 1) {
    const { message } = store.post({ channel: 'load', text: `${name} ${index}`, author: name });
    store.reply({ id: message.id, text: 'reply', author: name });
    store.label({ id: message.id, actor: name, set: { n: String(index) } });
  }
} else {
  try {
    process.stdout.write(store.claim({ channel: argument, actor: name }).id);
  } catch (error) {
    if (!(error instanceof BoardError) || error.reason !== 'nothing_ready') {
      throw error;
    }
  }
}
