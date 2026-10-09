# sns-http/ fixture sources (Amazon SNS HTTP/S delivery)

Fetched 2026-10-08. The source files use SNS's own `"Key" : "value"` formatting. The repo's oxfmt normalized the whitespace here to `"Key": "value"`. That is harmless: SNS signatures cover field **values**, not body bytes, and every message below still verifies after formatting.

## Real, verifiable messages

All eight messages below were verified offline on 2026-10-08 against the PEM in `certs/`, using the string-to-sign from the AWS docs (RSA-SHA1 for `SignatureVersion` 1, RSA-SHA256 for 2).

| Fixture | Source | Edits |
| --- | --- | --- |
| `subscription-confirmation.json` (v1) | aws/aws-sdk-java-v2 (Apache-2.0), `services-custom/sns-message-manager/src/test/resources/software/amazon/awssdk/messagemanager/sns/internal/test-subscription-confirmation.json`, https://github.com/aws/aws-sdk-java-v2/tree/master/services-custom/sns-message-manager/src/test/resources/software/amazon/awssdk/messagemanager/sns/internal | None (values unchanged; whitespace normalized by oxfmt) |
| `unsubscribe-confirmation.json` (v2) | Same directory, `test-unsubscribe-confirmation.json` | None |
| `notification-v1.json` | Same directory, `test-notification-no-subject.json` | None |
| `notification-v1-subject.json` | Same directory, `test-notification-with-subject.json` | None |
| `notification-v2.json` | Same directory, `test-notification-signature-v2.json` | None |
| `certs/SimpleNotificationService-7506a1e35b36ef5a444dd1a8e7cc3ed8.pem` | Same directory, same file name. Subject `CN=sns.amazonaws.com`, issuer `Amazon RSA 2048 M01`, **valid until 2026-10-14 23:59:59 GMT**. | None |
| `legacy-notification-v1.json`, `legacy-notification-v2.json` | `message_SHA1` / `message_SHA256` in aws/aws-sdk-ruby (Apache-2.0), `gems/aws-sdk-sns/spec/message_verifier_spec.rb`, https://github.com/aws/aws-sdk-ruby/blob/version-3/gems/aws-sdk-sns/spec/message_verifier_spec.rb | **Edited.** The Ruby heredoc interpolation `#{signing_cert_url.inspect}` was replaced with the URL it holds. |
| `legacy-notification-v2-subject.json` | Fourth entry of `getHttpFixtures()` in aws/aws-php-sns-message-validator (Apache-2.0), `tests/FunctionalValidationsTest.php`, https://github.com/aws/aws-php-sns-message-validator/blob/master/tests/FunctionalValidationsTest.php | **Edited.** The PHP array was written as SNS-style JSON. Field values are unchanged. |
| `certs/SimpleNotificationService-7ff5318490ec183fbaddaa2a969abfda.pem` | `$certificate` in the same PHP test, which is identical to `let(:cert)` in the Ruby spec. **Expired 2022-08-17.** | None |
| `*.headers.json` for the files above | **Derived.** The header set is from https://docs.aws.amazon.com/sns/latest/dg/http-header.html. Values come from each body: `x-amz-sns-subscription-arn` is the `SubscriptionArn` from `UnsubscribeURL` (or, for UnsubscribeConfirmation, the ARN in `Message`). It is left out for SubscriptionConfirmation, as in the doc example. | Derived |

Offline tests must not check certificate expiry against the real clock (both certs are expired or about to expire), and must not fetch the URL. Map `SigningCertURL` path basename to `certs/<basename>`.

## Doc examples (not verifiable)

| Fixture | Source | Edits |
| --- | --- | --- |
| `doc-notification.json` / `.headers.json` | Example `Notification` POST, https://docs.aws.amazon.com/sns/latest/dg/http-notification-json.html | None. `Signature` is `"EXAMPLEw6JRN..."`, so it cannot verify. |

## Derived S3-over-SNS fixtures (unsigned)

| Fixture | Source | Edits |
| --- | --- | --- |
| `s3-put.derived.json` | Envelope from the doc example above. `Message` is the S3 `ObjectCreated:Put` example from https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html, compact-stringified. | **Derived.** `{{amzn-s3-demo-bucket}}` resolved to `amzn-s3-demo-bucket`. `Subject` removed. `Signature` is `UNSIGNED-DERIVED-FIXTURE`. |
| `s3-test-event.derived.json` | Same, with the doc's "Amazon S3 test message" (`"Event":"s3:TestEvent"`) as `Message`. | Same as above |
| `raw-delivery-s3-put.derived.json` / `.headers.json` | Raw message delivery: "When you enable raw message delivery for HTTP/S endpoints, the HTTP header `x-amz-sns-rawdelivery` with its value set to `true` is added", and the body is the published message itself, https://docs.aws.amazon.com/sns/latest/dg/sns-large-payload-raw-message-delivery.html | **Derived.** The body is the S3 example. A raw delivery has **no signature at all**. |

## Signature, quoted

From https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html:

> "Notification message – Includes Message, MessageId, Subject (if present), Timestamp, TopicArn, and Type."
>
> "SubscriptionConfirmation or UnsubscribeConfirmation message – Includes Message, MessageId, SubscribeURL, Timestamp, Token, TopicArn, and Type."
>
> "Amazon SNS requires the string to sign to follow a strict, fixed field order for verification. Only the explicitly required fields must be included—no extra fields can be added. Optional fields, such as Subject, must be included only if present"
>
> "KeyNameOne\nValueOne\nKeyNameTwo\nValueTwo\n"
>
> "The complete string to sign ends with a single trailing newline character after the last field's value."
>
> "For SignatureVersion1, use SHA1 ... For SignatureVersion2, use SHA256"

From https://docs.aws.amazon.com/sns/latest/dg/http-subscription-confirmation-json.html: "If the `SignatureVersion` is **1**, `Signature` is a Base64-encoded `SHA1withRSA` signature ... If the `SignatureVersion` is **2**, `Signature` is a Base64-encoded `SHA256withRSA` signature". Topics default to version 1 (https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-configure-message-signature.html).

From https://docs.aws.amazon.com/sns/latest/dg/http-header.html: "By default, Amazon SNS sends all the notification to HTTP/S endpoints with `Content-Type` set to `text/plain; charset=UTF-8`."

## SigningCertURL host validation

- AWS docs (verify page): "Make sure the SigningCertURL is from a trusted AWS domain (for example, https://sns.us-east-1.amazonaws.com). Reject any URLs outside AWS domains."
- The official JS, PHP and Ruby validators all use `/^sns\.[a-zA-Z0-9\-]{3,}\.amazonaws\.com(\.cn)?$/`, require `https:`, and require a path ending in `.pem`. The PHP comment lists what it covers: `sns.<region>.amazonaws.com` (AWS), `sns.us-gov-west-1.amazonaws.com` (GovCloud), `sns.cn-north-1.amazonaws.com.cn` (China). Sources: `index.js` in https://github.com/aws/aws-js-sns-message-validator, `src/MessageValidator.php` in https://github.com/aws/aws-php-sns-message-validator, `lib/aws-sdk-sns/message_verifier.rb` in aws-sdk-ruby.
- The newest AWS implementation (aws-sdk-java-v2 `sns-message-manager`, `CertificateUrlValidator.java` + `SnsHostProvider.java`) is stricter. The cert URL host must **equal** the regional SNS endpoint host for the configured region. The certificate itself must match an expected common name: `sns.amazonaws.com` by default; `sns-signing.<region>.amazonaws.com` for ap-east-1, ap-east-2, ap-south-2, ap-southeast-3..7, me-south-1, me-central-1, eu-south-1, eu-south-2, eu-central-2, af-south-1, il-central-1, ca-west-1, mx-central-1; `sns-cn-north-1.amazonaws.com.cn` / `sns-cn-northwest-1.amazonaws.com.cn`; `sns-us-gov-west-1.amazonaws.com` (both GovCloud regions); `sns-us-iso-east-1.c2s.ic.gov`; `sns-us-isob-east-1.sc2s.sgov.gov`; `sns-signing.us-isof-*.csp.hci.ic.gov`; `sns-signing.eu-isoe-west-1.cloud.adc-e.uk`; `sns-signing.eusc-de-east-1.amazonaws.eu`. The ISO and EU sovereign hosts do **not** match the regex above.

## Handshake

From https://docs.aws.amazon.com/sns/latest/dg/SendMessageToHttp.prepare.html: "you must visit the `SubscribeURL` URL (for example, by sending an HTTP GET request to the URL)" or call `ConfirmSubscription` with `Token`. "Amazon SNS will not send notifications to the endpoint until you confirm the subscription." Retries: "By default, if the initial delivery fails, Amazon SNS attempts up to three retries with a delay between failed attempts set at 20 seconds." Dedupe on `MessageId`: "For a notification that Amazon SNS resends during a retry, the message ID of the original message is used."
