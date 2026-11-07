import fs from 'node:fs';

function extract(path) {
	const h = fs.readFileSync(path, 'utf8');
	const title = (h.match(/<title>([^<]+)<\/title>/) || [])[1];
	console.log('FILE', path);
	console.log('TITLE', title);
	const m = h.match(/"title":"([^"]+)"/);
	const m2 = h.match(/"state":"([^"]+)"/);
	const m3 = h.match(/"body":"((?:\\.|[^"\\])*)"/);
	console.log('emb title', m && m[1]);
	console.log('emb state', m2 && m2[1]);
	if (m3) {
		try {
			console.log('body', JSON.parse(`"${m3[1]}"`).slice(0, 2000));
		} catch {
			console.log('body raw', m3[1].slice(0, 1000));
		}
	}
	console.log('---');
}

extract(process.env.TEMP + '/339167.html');
extract(process.env.TEMP + '/341579.html');
