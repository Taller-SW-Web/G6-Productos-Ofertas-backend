"""Validate the approved H5 source contracts from a pinned Docs commit."""
import argparse
import json
import subprocess
from pathlib import Path

import yaml


def validate(openapi, asyncapi):
    if openapi.get('openapi') != '3.1.0' or openapi.get('info', {}).get('version') != '0.7.0-rc.3':
        raise ValueError('OpenAPI H5 version is missing or outdated')
    if asyncapi.get('asyncapi') != '3.0.0' or asyncapi.get('info', {}).get('version') != '0.7.0-rc.3':
        raise ValueError('AsyncAPI H5 version is missing or outdated')
    for label, document in [('OpenAPI', openapi), ('AsyncAPI', asyncapi)]:
        if document.get('x-g6-approval-status') != 'APPROVED_G6':
            raise ValueError(f'{label} is not approved by G6')
    operations = [(method, path, definition) for path, methods in openapi.get('paths', {}).items() for method, definition in methods.items() if method in {'get', 'post', 'put', 'patch', 'delete'}]
    if not operations or any(not definition.get('operationId') for _, _, definition in operations):
        raise ValueError('OpenAPI operation without implementation identifier')
    ids = [definition['operationId'] for _, _, definition in operations]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate OpenAPI operationId')
    messages = asyncapi.get('components', {}).get('messages', {})
    channels = asyncapi.get('channels', {})
    if not channels or not messages:
        raise ValueError('AsyncAPI channels or messages missing')
    for channel_id, channel in channels.items():
        if not channel.get('address') or not channel.get('x-producer') or not channel.get('x-consumer'):
            raise ValueError(f'Incomplete AsyncAPI channel {channel_id}')
        for message in channel.get('messages', {}).values():
            ref = message.get('$ref', '')
            if not ref.startswith('#/components/messages/') or ref.split('/')[-1] not in messages:
                raise ValueError(f'Unresolved AsyncAPI message in {channel_id}')
    return {'openapiOperations': len(operations), 'asyncapiChannels': len(channels), 'asyncapiMessages': len(messages)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('docs', type=Path)
    parser.add_argument('expected_sha')
    args = parser.parse_args()
    sha = subprocess.check_output(['git', '-C', str(args.docs), 'rev-parse', 'HEAD'], text=True).strip()
    if sha != args.expected_sha:
        raise SystemExit(f'Docs SHA mismatch: {sha}')
    openapi = yaml.safe_load((args.docs / 'contratos/http/openapi.yaml').read_text(encoding='utf-8'))
    asyncapi = yaml.safe_load((args.docs / 'contratos/eventos/asyncapi.yaml').read_text(encoding='utf-8'))
    print(json.dumps({'docsSha': sha, **validate(openapi, asyncapi)}, sort_keys=True))
