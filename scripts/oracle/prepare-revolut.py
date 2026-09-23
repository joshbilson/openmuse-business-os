"""Prepare a Revolut Business API X.509 certificate in Oracle's private secrets directory.

Run with the existing Oracle Python environment that has ``cryptography`` installed.
This creates no Revolut account settings and never prints private key material.
"""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from urllib.parse import urlparse

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def write_new(path: Path, content: bytes) -> None:
    # Exclusive create inherits the protected directory ACL on Windows.
    with path.open("xb") as output:
        output.write(content)
        output.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--secrets-dir", default=r"C:\OpenMuseBusinessOS\secrets", type=Path,
        help="Existing ACL-protected Oracle secrets directory",
    )
    parser.add_argument(
        "--public-url", required=True,
        help="Exact HTTPS PUBLIC_API_URL used by the Oracle deployment",
    )
    args = parser.parse_args()
    url = urlparse(args.public_url)
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username
        or url.password
        or url.path not in ("", "/")
        or url.query
        or url.fragment
    ):
        parser.error("--public-url must be an HTTPS origin without credentials or path")
    if not args.secrets_dir.is_dir() or args.secrets_dir.is_symlink():
        parser.error("--secrets-dir must already be an ACL-protected real directory")

    key_path = args.secrets_dir / "revolut-private.pem"
    cert_path = args.secrets_dir / "revolut-public.cer"
    if cert_path.exists() and not key_path.exists():
        parser.error("public certificate exists without its private key; refusing to create a mismatched pair")

    if key_path.exists():
        key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
        if not isinstance(key, rsa.RSAPrivateKey) or key.key_size != 2048:
            parser.error("existing Revolut private key must be an unencrypted RSA-2048 PEM")
        created_key = False
    else:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        private_pem = key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
        write_new(key_path, private_pem)
        created_key = True

    if cert_path.exists():
        certificate = x509.load_pem_x509_certificate(cert_path.read_bytes())
        if certificate.public_key().public_numbers() != key.public_key().public_numbers():
            parser.error("existing certificate does not match the private key")
        names = certificate.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
        if not names or names[0].value != url.hostname:
            parser.error("existing certificate hostname differs from the public URL")
        if certificate.not_valid_after_utc <= datetime.now(timezone.utc):
            parser.error("existing Revolut certificate has expired; rotate it deliberately")
        created_cert = False
    else:
        now = datetime.now(timezone.utc)
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, url.hostname)])
        certificate = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=1825))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(url.hostname)]), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(key, hashes.SHA256())
        )
        write_new(cert_path, certificate.public_bytes(serialization.Encoding.PEM))
        created_cert = True

    print(json.dumps({
        "publicCertificatePath": str(cert_path),
        "certificateSha256": hashlib.sha256(cert_path.read_bytes()).hexdigest(),
        "issuerHostname": url.hostname,
        "createdPrivateKey": created_key,
        "createdPublicCertificate": created_cert,
    }))


if __name__ == "__main__":
    main()
