import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('check_h5_contracts', Path(__file__).with_name('check-h5-contracts.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ContractNegativeTests(unittest.TestCase):
    def setUp(self):
        self.openapi = {'openapi': '3.1.0', 'info': {'version': '0.7.0-rc.3'}, 'x-g6-approval-status': 'APPROVED_G6', 'paths': {'/products': {'get': {'operationId': 'listProducts'}}}}
        self.asyncapi = {'asyncapi': '3.0.0', 'info': {'version': '0.7.0-rc.3'}, 'x-g6-approval-status': 'APPROVED_G6', 'components': {'messages': {'ProductChanged': {}}}, 'channels': {'products': {'address': 'g6.catalog.from.bulk', 'x-producer': 'bulk-svc', 'x-consumer': 'catalog-svc', 'messages': {'ProductChanged': {'$ref': '#/components/messages/ProductChanged'}}}}}

    def test_positive_and_missing_openapi_operation(self):
        self.assertEqual(module.validate(self.openapi, self.asyncapi)['openapiOperations'], 1)
        broken = copy.deepcopy(self.openapi)
        del broken['paths']['/products']['get']['operationId']
        with self.assertRaisesRegex(ValueError, 'without implementation identifier'):
            module.validate(broken, self.asyncapi)

    def test_unresolved_asyncapi_message_fails(self):
        broken = copy.deepcopy(self.asyncapi)
        broken['channels']['products']['messages']['ProductChanged']['$ref'] = '#/components/messages/Missing'
        with self.assertRaisesRegex(ValueError, 'Unresolved'):
            module.validate(self.openapi, broken)


if __name__ == '__main__':
    unittest.main()
