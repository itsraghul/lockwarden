// Test fixture — every credential in here is deliberately fake.
// The access key below is AWS's officially documented example key ID.
// __LW_FIXTURE_*__ placeholders are replaced with runtime-built tokens by
// the integration test (committed files must never contain secret-shaped
// literals, or GitHub push protection rejects the branch).
const awsAccessKeyId = 'AKIAIOSFODNN7EXAMPLE';
const stripeTest = '__LW_FIXTURE_STRIPE_TEST__';
const apiKey = '__LW_FIXTURE_ENTROPY__';

module.exports = { awsAccessKeyId, stripeTest, apiKey };
