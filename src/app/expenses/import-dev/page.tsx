import { redirect } from 'next/navigation'

export default function ImportDevRedirect() {
  redirect('/expenses/import')
}
