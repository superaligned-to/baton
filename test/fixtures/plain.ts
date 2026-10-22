import { baton } from "@superaligned/baton";

type Document = { doc: string; text: string };

const configureTools = (secret: string) => {
  const docs = new Map([["README.md", "# baton"]]);
  const flow = baton({ name: "edit-document", secret });

  const read = flow
    .step("read_doc")
    .description("Read the document before editing it.")
    .func(({ doc }: { doc: string }) => ({ doc, text: docs.get(doc) ?? "" }));

  const edit = flow
    .step("edit_doc", {
      locked: true,
      from: { doc: read.output((result) => result.doc) },
    })
    .description("Save changes to the document that was read.")
    .func(({ doc, text }: Document) => {
      docs.set(doc, text);

      return { doc, text };
    });

  return {
    flow,
    read_doc: read.func,
    edit_doc: edit.func,
    get_doc: (doc: string) => docs.get(doc),
  };
};

export const createTools = (
  secret = process.env.BATON_SECRET ?? "",
): ReturnType<typeof configureTools> => configureTools(secret);
