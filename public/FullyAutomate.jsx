export default function FullyAutomate() {
  const [text, setText] = React.useState("");
  const [file, setFile] = React.useState(null);
  const [output, setOutput] = React.useState(null);
  const [loading, setLoading] = React.useState(false);

  async function run() {
    setLoading(true);

    const fd = new FormData();
    fd.append("requirementsText", text);
    if (file) fd.append("requirementsFile", file);

    const res = await fetch("/fully-automate", {
      method: "POST",
      body: fd
    });

    const data = await res.json();
    setOutput(data.output);
    setLoading(false);
  }

  return (
    <div style={{padding:20}}>
      <h2>Fully Automate</h2>

      <input type="file"
        onChange={(e)=>setFile(e.target.files[0])}
      />

      <textarea
        placeholder="Paste requirements..."
        value={text}
        onChange={(e)=>setText(e.target.value)}
        rows={8}
        style={{width:"100%",marginTop:10}}
      />

      <button onClick={run} disabled={loading}>
        {loading ? "Generating..." : "Generate"}
      </button>

      {output && (
        <pre>{JSON.stringify(output,null,2)}</pre>
      )}
    </div>
  );
}
