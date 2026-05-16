import { Akamai } from "./akamai";
import { Appwrite } from "./appwrite";
import { Azure } from "./azure";
import { BackblazeB2 } from "./backblaze-b2";
import { Box } from "./box";
import { BunS3 } from "./bun-s3";
import { DigitalOceanSpaces } from "./digitalocean-spaces";
import { Dropbox } from "./dropbox";
import { Exoscale } from "./exoscale";
import { Filebase } from "./filebase";
import { Fs } from "./fs";
import { Gcs } from "./gcs";
import { GoogleDrive } from "./google-drive";
import { Hetzner } from "./hetzner";
import { IbmCos } from "./ibm-cos";
import { IdriveE2 } from "./idrive-e2";
import { Minio } from "./minio";
import { NetlifyBlobs } from "./netlify-blobs";
import { Onedrive } from "./onedrive";
import { OracleCloud } from "./oracle-cloud";
import { Ovhcloud } from "./ovhcloud";
import { R2 } from "./r2";
import { S3 } from "./s3";
import { Scaleway } from "./scaleway";
import { Storj } from "./storj";
import { Supabase } from "./supabase";
import { Tigris } from "./tigris";
import { Uploadthing } from "./uploadthing";
import { VercelBlob } from "./vercel-blob";
import { Vultr } from "./vultr";
import { Wasabi } from "./wasabi";

export const Adapters = () => (
  <section>
    <S3 />
    <BunS3 />
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
    <Scaleway />
    <Ovhcloud />
    <IdriveE2 />
    <Vultr />
    <Filebase />
    <Exoscale />
    <OracleCloud />
    <IbmCos />
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
    <Appwrite />
  </section>
);
