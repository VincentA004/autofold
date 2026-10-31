"""Europe PMC, UniProt and PDB search/fetch with local source captures; stdlib only."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import uuid
import xml.etree.ElementTree as ET

API = 'https://www.ebi.ac.uk/europepmc/webservices/rest'
MAX_BYTES = 8 * 1024 * 1024


class ResearchError(ValueError):
    pass


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


class PlainText(HTMLParser):
    blocks = {'p', 'div', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'section'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def handle_starttag(self, tag, attrs):
        if tag in self.blocks:
            self.parts.append(' ')

    def handle_endtag(self, tag):
        if tag in self.blocks:
            self.parts.append(' ')


def plain(value):
    parser = PlainText()
    parser.feed(value or '')
    return ' '.join(''.join(parser.parts).split())


def download(url, directory, filename, timeout, *, payload=None, allow_no_content=False):
    request = Request(url, headers={'Accept': 'application/json, application/xml',
                                   'Content-Type': 'application/json',
                                   'User-Agent': 'Autofold-research/1.0'},
                      data=json.dumps(payload).encode() if payload is not None else None)
    with urlopen(request, timeout=timeout) as response:
        data = response.read(MAX_BYTES + 1)
        no_content = getattr(response, 'status', None) == 204
    if len(data) > MAX_BYTES:
        (directory / (filename + '.partial')).write_bytes(data[:MAX_BYTES])
        raise ResearchError(f'Response exceeds {MAX_BYTES} bytes; partial content retained')
    (directory / filename).write_bytes(data)
    if not data and not (allow_no_content and no_content):
        raise ResearchError('Unexpected empty HTTP response')
    return data


def search_records(data):
    payload = json.loads(data)
    result_list = payload.get('resultList') if isinstance(payload, dict) else None
    if not isinstance(result_list, dict) or not isinstance(result_list.get('result'), list):
        raise ResearchError('Europe PMC response has no valid resultList.result; not an empty search')
    records = result_list['result']
    if not all(isinstance(record, dict) and isinstance(record.get('source'), str) and isinstance(record.get('id'), str) and record['source'] and record['id'] for record in records):
        raise ResearchError('Europe PMC returned an incomplete record identity')
    return payload, records


def xml_text(data, pmcid):
    root = ET.fromstring(data)
    tag = lambda node: node.tag.rsplit('}', 1)[-1]
    if tag(root) != 'article':
        raise ResearchError('Response is not article XML')
    ids = [''.join(n.itertext()).strip() for n in root.iter()
           if tag(n) == 'article-id' and n.get('pub-id-type') in ('pmc', 'pmcid')]
    if not ids or not any(('PMC' + value.removeprefix('PMC')) == pmcid for value in ids):
        raise ResearchError('Full-text article identity does not match the requested PMCID')
    bodies = [n for n in root.iter() if tag(n) == 'body']
    if len(bodies) != 1 or not ''.join(bodies[0].itertext()).strip():
        raise ResearchError('Article has no body; full text was not retrieved')
    paragraphs = []
    for node in root.iter():
        if tag(node) == 'tr':
            cells = [' '.join(''.join(cell.itertext()).split()) for cell in node
                     if tag(cell) in ('td', 'th')]
            if cells:
                paragraphs.append(' | '.join(cells))
        elif tag(node) in ('article-title', 'title', 'p', 'disp-formula'):
            text = ' '.join(''.join(node.itertext()).split())
            if text:
                paragraphs.append(text)
    return '\n\n'.join(paragraphs) or ' '.join(bodies[0].itertext())


def retrieve(action, value, *, workspace, limit=5, full_text=False, timeout=20):
    if action not in ('search', 'fetch'):
        raise ResearchError('Action must be search or fetch')
    if action == 'search' and full_text:
        raise ResearchError('Full text applies to fetch')
    if not value.strip() or not 1 <= limit <= 20 or not 0 < timeout <= 60:
        raise ResearchError('Supply a nonempty query, limit 1..20 and timeout in (0,60]')
    if action == 'fetch' and not re.fullmatch(r'[A-Z][A-Z0-9]{1,7}/[A-Za-z0-9][A-Za-z0-9._-]{0,119}', value):
        raise ResearchError('Fetch needs the exact SOURCE/ID returned by search, e.g. MED/12345678')
    directory = Path(workspace).resolve() / 'sources' / 'europepmc' / uuid.uuid4().hex
    directory.mkdir(parents=True)
    query = value if action == 'search' else 'ext_id:' + value.split('/')[1] + ' AND src:' + value.split('/')[0]
    url = API + '/search?' + urlencode({'query': query, 'format': 'json', 'resultType': 'core',
                                       'pageSize': limit if action == 'search' else 1})
    request = {'source': 'europepmc', 'action': action, 'value': value, 'url': url,
               'requested_at': datetime.now(timezone.utc).isoformat(), 'full_text_requested': full_text}
    write_json(directory / 'request.json', request)
    try:
        payload, records = search_records(download(url, directory, 'response.json', timeout))
        if action == 'search':
            result = {'kind': 'search_results', 'query': value, 'hit_count': payload.get('hitCount'),
                      'returned': len(records), 'directory': str(directory), 'results': [
                          {'id': r['source'] + '/' + r['id'], 'title': plain(r.get('title')),
                           'year': r.get('pubYear'), 'doi': r.get('doi'), 'pmcid': r.get('pmcid'),
                           'url': f"https://europepmc.org/article/{r['source']}/{r['id']}",
                           'preview': plain(r.get('abstractText'))[:600]} for r in records]}
            write_json(directory / 'search.json', result)
            return result
        if len(records) != 1 or records[0]['source'] + '/' + records[0]['id'] != value:
            raise ResearchError('Fetched record identity differs from requested SOURCE/ID, or record is missing')
        record = records[0]
        text = plain(record.get('abstractText'))
        scope = 'abstract' if text else 'metadata_only'
        full = {'requested': full_text, 'status': 'not_requested'}
        if full_text:
            pmcid = record.get('pmcid') or ''
            if not re.fullmatch(r'PMC[0-9]+', pmcid):
                full.update(status='unavailable', reason='Fetched metadata has no PMCID')
            else:
                full['url'] = API + '/' + pmcid + '/fullTextXML'
                try:
                    raw = download(full['url'], directory, 'fulltext.xml', timeout)
                    text = xml_text(raw, pmcid)
                    scope = 'full_text'
                    full.update(status='retrieved')
                except HTTPError as error:
                    # Availability failures preserve the metadata/abstract, explicitly.
                    # Transport timeouts and connection failures remain fatal below.
                    if error.code not in (403, 404):
                        raise
                    full.update(status='unavailable', reason=str(error))
        (directory / 'text.txt').write_text(text + ('\n' if text else ''), encoding='utf-8')
        artifacts = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.iterdir()
                     if p.name in ('response.json', 'fulltext.xml', 'text.txt')}
        result = {'kind': 'source', 'source': 'europepmc', 'id': value, 'title': plain(record.get('title')),
                  'doi': record.get('doi'), 'year': record.get('pubYear'),
                  'url': f'https://europepmc.org/article/{value}', 'retrieved_at': datetime.now(timezone.utc).isoformat(),
                  'scope': scope, 'full_text': full, 'text_path': str(directory / 'text.txt'),
                  'directory': str(directory), 'sha256': artifacts}
        write_json(directory / 'source.json', result)
        return result
    except Exception as error:
        write_json(directory / 'error.json', {'type': type(error).__name__, 'message': str(error),
                                             'request': 'request.json'})
        error.add_note(f'Capture directory: {directory}')
        raise


def accession(value):
    value = value.upper()
    if not re.fullmatch(r'(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-[1-9][0-9]*)?', value):
        raise ResearchError('Supply a UniProt accession, e.g. P01479')
    return value


def protein_summary(record):
    description = record.get('proteinDescription', {})
    name = description.get('recommendedName') or next(iter(description.get('submissionNames', [])), {})
    return {'id': record['primaryAccession'], 'name': name.get('fullName', {}).get('value'),
            'organism': record.get('organism', {}).get('scientificName'),
            'entry_type': record.get('entryType'), 'length': record.get('sequence', {}).get('length')}


def retrieve_database(provider, action, value, *, workspace, limit=5, timeout=20,
                      uniprot=None, assembly=None):
    """Thin source-specific adapters: no sequence cropping or coordinate preparation."""
    if provider not in ('uniprot', 'pdb') or action not in ('search', 'fetch'):
        raise ResearchError('Unknown database or action')
    if not 1 <= limit <= 20 or not 0 < timeout <= 60:
        raise ResearchError('Limit must be 1..20 and timeout in (0,60]')
    if provider == 'uniprot' and (uniprot or assembly):
        raise ResearchError('UniProt does not accept PDB options')
    if provider == 'pdb' and action == 'search':
        if bool(value) == bool(uniprot) or assembly:
            raise ResearchError('PDB search needs either text or --uniprot')
        if uniprot:
            uniprot = accession(uniprot)
    elif not value or not value.strip():
        raise ResearchError('Supply a nonempty query or identity')
    if action == 'fetch':
        if uniprot:
            raise ResearchError('--uniprot applies to PDB search')
        if provider == 'uniprot':
            value = accession(value)
        else:
            value = value.upper()
            if not re.fullmatch(r'[1-9][A-Z0-9]{3}|PDB_[A-Z0-9]{8}', value):
                raise ResearchError('Supply a PDB entry ID')
            if assembly is not None and not re.fullmatch(r'[1-9][0-9]{0,5}', assembly):
                raise ResearchError('Assembly must be an explicit positive integer')
    directory = Path(workspace).resolve() / 'sources' / provider / uuid.uuid4().hex
    directory.mkdir(parents=True)
    request = {'source': provider, 'action': action, 'value': value, 'uniprot': uniprot,
               'assembly': assembly, 'limit': limit,
               'requested_at': datetime.now(timezone.utc).isoformat(), 'requests': []}

    def get(url, filename, *, payload=None, empty=False):
        request['requests'].append({'url': url, 'method': 'POST' if payload else 'GET',
                                    'file': filename, **({'payload': payload} if payload else {})})
        write_json(directory / 'request.json', request)
        return download(url, directory, filename, timeout, payload=payload, allow_no_content=empty)

    try:
        if provider == 'uniprot':
            url = 'https://rest.uniprot.org/uniprotkb/'
            url += ('search?' + urlencode({'query': value, 'format': 'json', 'size': limit})
                    if action == 'search' else value + '.json')
            record = json.loads(get(url, 'response.json'))
            if action == 'search':
                records = record.get('results')
                if not isinstance(records, list) or not all(isinstance(r, dict) and r.get('primaryAccession') for r in records):
                    raise ResearchError('UniProt response has no valid results; not an empty search')
                details = {'results': [protein_summary(r) for r in records], 'returned': len(records),
                           'scope': 'search_results', 'note': 'Bounded first page; not an exhaustive inventory.'}
            else:
                identity = record.get('primaryAccession')
                isoform_ids = [i for c in record.get('comments', []) for iso in c.get('isoforms', []) for i in iso.get('isoformIds', [])]
                if identity != value and value not in isoform_ids:
                    raise ResearchError('Fetched UniProt identity differs; accession redirects are not silently adopted')
                if not isinstance(record.get('sequence', {}).get('value'), str) or not record['sequence']['value']:
                    raise ResearchError('UniProt record has no sequence')
                # Isoform-specific sequence retrieval is deliberately outside this interface.
                if identity != value:
                    raise ResearchError('Fetch the canonical accession; isoform sequence selection is not supported')
                lines = [json.dumps(protein_summary(record), ensure_ascii=False),
                         'Sequence (full record; not automatically mature): ' + record['sequence']['value']]
                for key in ('entryAudit', 'proteinDescription', 'comments', 'features', 'uniProtKBCrossReferences', 'references'):
                    lines.append(key + ':')
                    values = record.get(key, [])
                    for item in values if isinstance(values, list) else [values]:
                        lines.append(json.dumps(item, ensure_ascii=False))
                details = {**protein_summary(record), 'scope': 'protein_record',
                           'entry_audit': record.get('entryAudit'), 'annotation_evidence': 'Retained per annotation in response.json and text.txt.'}
        elif action == 'search':
            query = ({'type': 'group', 'logical_operator': 'and', 'nodes': [
                {'type': 'terminal', 'service': 'text', 'parameters': {
                    'attribute': 'rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_accession',
                    'operator': 'exact_match', 'value': uniprot}},
                {'type': 'terminal', 'service': 'text', 'parameters': {
                    'attribute': 'rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_name',
                    'operator': 'exact_match', 'value': 'UniProt'}}]}
                if uniprot else {'type': 'terminal', 'service': 'full_text', 'parameters': {'value': value}})
            payload = {'query': query, 'return_type': 'entry', 'request_options': {
                'paginate': {'start': 0, 'rows': limit}, 'results_content_type': ['experimental']}}
            raw = get('https://search.rcsb.org/rcsbsearch/v2/query', 'response.json', payload=payload, empty=True)
            record = json.loads(raw) if raw else {'total_count': 0, 'result_set': []}
            records = record.get('result_set')
            if not isinstance(records, list) or not all(isinstance(r, dict) and r.get('identifier') for r in records):
                raise ResearchError('PDB response has no valid result_set; not an empty search')
            details = {'scope': 'search_results', 'results': records, 'returned': len(records),
                       'hit_count': record.get('total_count'), 'content_type': 'experimental',
                       'note': 'UniProt match is an entry-level discovery aid; verify each entity mapping on fetch.'}
        else:
            api = 'https://data.rcsb.org/rest/v1/core/'
            url = api + 'entry/' + value
            record = json.loads(get(url, 'response.json'))
            ids = record.get('rcsb_entry_container_identifiers', {})
            if ids.get('entry_id', '').upper() != value:
                raise ResearchError('Fetched PDB entry identity differs')
            entity_ids = ids.get('polymer_entity_ids', [])
            if not entity_ids or len(entity_ids) > 50 or not all(re.fullmatch(r'[0-9]+', i) for i in entity_ids):
                raise ResearchError('PDB fetch requires 1..50 explicitly identified polymer entities')
            entities = []
            for entity_id in entity_ids:
                entity = json.loads(get(api + 'polymer_entity/' + value + '/' + entity_id,
                                        'entity-' + entity_id + '.json'))
                container = entity.get('rcsb_polymer_entity_container_identifiers', {})
                if container.get('entry_id', '').upper() != value or container.get('entity_id') != entity_id:
                    raise ResearchError('Fetched PDB entity identity differs')
                entities.append({'identity_and_chains': container, 'polymer': entity.get('entity_poly'),
                                 'reference_alignments': entity.get('rcsb_polymer_entity_align', []),
                                 'description': entity.get('rcsb_polymer_entity')})
            if assembly:
                if assembly not in ids.get('assembly_ids', []):
                    raise ResearchError('Requested assembly is not declared by the entry')
                assembly_record = json.loads(get(api + 'assembly/' + value + '/' + assembly, 'assembly.json'))
                aid = assembly_record.get('rcsb_assembly_container_identifiers', {})
                if aid.get('entry_id', '').upper() != value or aid.get('assembly_id') != assembly:
                    raise ResearchError('Fetched PDB assembly identity differs')
            coordinates_url = 'https://files.rcsb.org/download/' + value + (('-assembly' + assembly) if assembly else '') + '.cif'
            cif = get(coordinates_url, 'structure.cif').decode('utf-8')
            declared = re.search(r"(?m)^_entry\.id\s+['\"]?([A-Za-z0-9_]+)", cif)
            declared_id = declared.group(1).upper() if declared else None
            # RCSB assembly exports can legitimately replace the entry tag with XXXX.
            if declared_id != value and not (assembly and declared_id == 'XXXX'):
                raise ResearchError('Coordinate entry identity differs')
            if not cif.lstrip().startswith('data_') or not all('_atom_site.Cartn_' + axis in cif for axis in 'xyz'):
                raise ResearchError('Response is not coordinate mmCIF')
            details = {'id': value, 'scope': 'structure_record', 'title': record.get('struct', {}).get('title'),
                       'experimental_methods': record.get('exptl', []),
                       'methodology': record.get('rcsb_entry_info', {}).get('structure_determination_methodology'),
                       'resolution_angstrom': record.get('rcsb_entry_info', {}).get('resolution_combined'),
                       'assembly': assembly, 'available_assemblies': ids.get('assembly_ids', []),
                       'coordinate_scope': 'biological_assembly' if assembly else 'deposited_entry',
                       'coordinate_declared_entry_id': declared_id, 'coordinate_url': coordinates_url,
                       'entities': entities,
                       'note': 'Coordinates are unmodified. Assembly XXXX identity relies on requested URL and validated metadata, not an entry tag. Check residue mapping and chemistry before preparation.'}
            lines = [json.dumps(details, ensure_ascii=False),
                     'Primary citation: ' + json.dumps(record.get('rcsb_primary_citation'), ensure_ascii=False)]
        if action == 'search':
            result = {'kind': 'search_results', 'source': provider, 'query': value or uniprot,
                      'directory': str(directory), **details}
            result['sha256'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                for p in directory.iterdir() if p.is_file()}
            write_json(directory / 'search.json', result)
        else:
            (directory / 'text.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
            result = {'kind': 'source', 'source': provider, 'url': url, 'directory': str(directory),
                      'retrieved_at': datetime.now(timezone.utc).isoformat(),
                      'text_path': str(directory / 'text.txt'), **details,
                      'sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                 for p in directory.iterdir() if p.is_file()}}
            write_json(directory / 'source.json', result)
        return result
    except Exception as error:
        write_json(directory / 'error.json', {'type': type(error).__name__, 'message': str(error), 'request': 'request.json'})
        error.add_note(f'Capture directory: {directory}')
        raise


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    provider = argv.pop(0) if argv and argv[0] in ('uniprot', 'pdb') else None
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['search', 'fetch'])
    parser.add_argument('value', nargs='?', help='Query or exact record identity; legacy commands use Europe PMC')
    parser.add_argument('--workspace', type=Path, default=Path.cwd())
    parser.add_argument('--limit', type=int, default=5)
    parser.add_argument('--full-text', action='store_true', help='Fetch available article XML; report unavailable explicitly')
    parser.add_argument('--timeout', type=float, default=20)
    parser.add_argument('--uniprot', help='PDB search by UniProt accession')
    parser.add_argument('--assembly', help='Explicit PDB biological assembly; otherwise deposited coordinates')
    args = parser.parse_args(argv)
    if args.full_text and (provider or args.action == 'search'):
        parser.error('--full-text applies to fetch')
    if not provider and (args.uniprot or args.assembly or not args.value):
        parser.error('Europe PMC needs a value and does not accept PDB options')
    try:
        result = (retrieve_database(provider, args.action, args.value, workspace=args.workspace,
                                    limit=args.limit, timeout=args.timeout, uniprot=args.uniprot,
                                    assembly=args.assembly) if provider else
                  retrieve(args.action, args.value, workspace=args.workspace, limit=args.limit,
                           full_text=args.full_text, timeout=args.timeout))
    except Exception as error:
        print(json.dumps({'error': type(error).__name__, 'message': str(error),
                          'notes': getattr(error, '__notes__', [])}), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
