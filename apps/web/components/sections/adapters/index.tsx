import { Heading } from "@/components/heading";

import { Akamai } from "./akamai";
import { Azure } from "./azure";
import { BackblazeB2 } from "./backblaze-b2";
import { Box } from "./box";
import { DigitalOceanSpaces } from "./digitalocean-spaces";
import { Dropbox } from "./dropbox";
import { Fs } from "./fs";
import { Gcs } from "./gcs";
import { GoogleDrive } from "./google-drive";
import { Hetzner } from "./hetzner";
import { Minio } from "./minio";
import { NetlifyBlobs } from "./netlify-blobs";
import { Onedrive } from "./onedrive";
import { R2 } from "./r2";
import { S3 } from "./s3";
import { Storj } from "./storj";
import { Supabase } from "./supabase";
import { Tigris } from "./tigris";
import { Uploadthing } from "./uploadthing";
import { VercelBlob } from "./vercel-blob";
import { Wasabi } from "./wasabi";

export const Adapters = () => (
  <section>
    <Heading as="h2">Adapters</Heading>
    <p>
      Each adapter is a subpath import. Bring only what you use; the others
      tree-shake away. Adapters auto-load credentials from the standard
      environment variables for that provider — pass options explicitly to
      override. If an adapter is constructed without enough info to
      authenticate, it throws at construction time naming the missing variable.
    </p>
    <S3 />
    <R2 />
    <VercelBlob />
    <NetlifyBlobs />
    <Minio />
    <DigitalOceanSpaces />
    <Storj />
    <Hetzner />
    <Akamai />
    <BackblazeB2 />
    <Wasabi />
    <Tigris />
    <Gcs />
    <GoogleDrive />
    <Onedrive />
    <Dropbox />
    <Box />
    <Azure />
    <Supabase />
    <Uploadthing />
    <Fs />
  </section>
);
